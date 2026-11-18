import { useState } from "react";
import { AppShell } from "../src/app-shell";
import { defaultServices } from "../src/auth-context";

export default function RootLayout() {
  const [services] = useState(defaultServices);
  return <AppShell services={services} />;
}
