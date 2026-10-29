import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("RSLMC: #root element is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
