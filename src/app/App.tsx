import type { ReactElement } from "react";

import { AppShell } from "./layout/AppShell";
import { Providers } from "./providers";

export default function App(): ReactElement {
  return (
    <Providers>
      <AppShell />
    </Providers>
  );
}
