import { FleetProvider, useFleet } from './store/FleetContext';
import { NotificationToasts } from './components/NotificationToasts';
import { ControlTower } from './views/ControlTower';
import { Business } from './views/Business';
import { Driver } from './views/Driver';
import { Register } from './views/Register';
import { RoleSelect } from './views/RoleSelect';

function Router() {
  const { mode } = useFleet();
  if (mode === 'REGISTER') return <Register />;
  if (mode === 'CONTROL_TOWER') return <ControlTower />;
  if (mode === 'BUSINESS') return <Business />;
  if (mode === 'DRIVER') return <Driver />;
  return <RoleSelect />;
}

export default function App() {
  return (
    <FleetProvider>
      <Router />
      {/* Mounted once at the app root so a decline reaches the requester no matter
          which screen they are on. */}
      <NotificationToasts />
    </FleetProvider>
  );
}
