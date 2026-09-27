import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../src/store/jsonStore';

/**
 * Unit tests for the JSON store itself.
 *
 * These need no running server. The one that matters is the concurrency test: the store
 * is a read-modify-write over a shared cache, and serialising only the file write let
 * parallel creates silently drop rows. That bug shipped once already, taking four of
 * five driver notifications with it, so it gets a direct test rather than being covered
 * only by the end-to-end flow.
 */

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

interface Row extends Record<string, unknown> {
  id: string;
  n: number;
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fleetgrid-store-'));

  try {
    section('1. Plain create / read / update / delete');
    {
      const store = createJsonStore<Row>({ filePath: join(dir, 'a.json'), name: 'a' });
      await store.create({ id: 'x1', n: 1 });
      await store.create({ id: 'x2', n: 2 });
      check('Two rows are stored', (await store.get()).length === 2, (await store.get()).length);
      check('findById returns the row', (await store.findById('x2'))?.n === 2);
      check('update shallow-merges and keeps the id',
        (await store.update('x1', { n: 9 }))?.n === 9);
      check('update on a missing id returns undefined',
        (await store.update('nope', { n: 1 })) === undefined);
      check('delete reports true when a row went', (await store.delete('x1')) === true);
      check('delete reports false when nothing matched', (await store.delete('x1')) === false);
      check('One row left', (await store.get()).length === 1);

      // The file on disk is the source of truth after a restart, not just the cache.
      const onDisk = JSON.parse(await readFile(join(dir, 'a.json'), 'utf8')) as Row[];
      check('The file on disk matches the cache', onDisk.length === 1 && onDisk[0].id === 'x2', onDisk);
    }

    section('2. Concurrent creates must not lose rows');
    {
      const store = createJsonStore<Row>({ filePath: join(dir, 'race.json'), name: 'race' });
      // This is exactly the shape the broadcast open path uses: one notification per
      // eligible driver, all created in parallel.
      await Promise.all(
        Array.from({ length: 25 }, (_, i) => store.create({ id: `n${i}`, n: i })),
      );
      const rows = await store.get();
      check('All 25 parallel creates survived', rows.length === 25, rows.length);
      check('No id was written twice', new Set(rows.map((r) => r.id)).size === 25);
      const onDisk = JSON.parse(await readFile(join(dir, 'race.json'), 'utf8')) as Row[];
      check('The file on disk has all 25 too', onDisk.length === 25, onDisk.length);
    }

    section('3. Concurrent updates to the same row do not resurrect stale values');
    {
      const store = createJsonStore<Row>({ filePath: join(dir, 'upd.json'), name: 'upd' });
      await store.create({ id: 'only', n: 0 });
      await Promise.all(Array.from({ length: 20 }, (_, i) => store.update('only', { n: i + 1 })));
      const row = await store.findById('only');
      // Any value is legal here; what matters is that the row still exists and the file
      // is valid JSON, i.e. the last write won cleanly rather than corrupting the store.
      check('The row still exists after 20 parallel updates', row !== undefined, row);
      const onDisk = JSON.parse(await readFile(join(dir, 'upd.json'), 'utf8')) as Row[];
      check('The file is a single valid row', onDisk.length === 1, onDisk);
    }

    section('4. A rejected duplicate does not wedge later writes');
    {
      const store = createJsonStore<Row>({ filePath: join(dir, 'dup.json'), name: 'dup' });
      await store.create({ id: 'dup', n: 1 });
      let threw = false;
      try {
        await store.create({ id: 'dup', n: 2 });
      } catch {
        threw = true;
      }
      check('A duplicate id throws', threw);
      // The chain must survive the rejection, otherwise every later write to this
      // collection hangs forever.
      await store.create({ id: 'after', n: 3 });
      check('A later write still succeeds after a rejected one',
        (await store.findById('after'))?.n === 3);
    }

    section('5. replaceAll and clear');
    {
      const store = createJsonStore<Row>({ filePath: join(dir, 'bulk.json'), name: 'bulk' });
      await store.replaceAll([
        { id: 'a', n: 1 },
        { id: 'b', n: 2 },
      ]);
      check('replaceAll sets the collection', (await store.get()).length === 2);
      await store.clear();
      check('clear empties it', (await store.get()).length === 0);
    }

    console.log(`\n${'='.repeat(56)}`);
    console.log(`  passed: ${passed}   failed: ${failed}`);
    console.log('='.repeat(56));
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nStore test run crashed:', err);
  process.exit(1);
});
