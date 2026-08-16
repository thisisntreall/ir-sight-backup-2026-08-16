import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IrScanner } from "@/components/ir-scanner";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IrScanner />
  </StrictMode>,
);
