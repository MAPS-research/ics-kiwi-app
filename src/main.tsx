import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./styles/assess.css";
import "./styles/grade.css";
import "./styles/airules.css";
import "./styles/airun.css";
import "./styles/telemetry.css";
import "./styles/insights.css";
import "./styles/people.css";

const root = document.getElementById("root");
if (!root) throw new Error("The page is missing its #root element.");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
