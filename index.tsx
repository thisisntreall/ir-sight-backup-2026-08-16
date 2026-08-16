import { createFileRoute } from "@tanstack/react-router";
import { IrScanner } from "@/components/ir-scanner";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <IrScanner />;
}
