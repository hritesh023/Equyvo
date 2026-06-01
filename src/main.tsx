import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./globals.css";

console.log('🚀 Starting Full Equyvo App...');

try {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    console.error('❌ Root element not found');
    document.body.innerHTML = '<div style="color: red; padding: 20px;">❌ Root element not found</div>';
    throw new Error("Root element not found");
  }

  console.log('✅ Root element found, creating React root...');
  const root = createRoot(rootElement);

  console.log('✅ Rendering full Equyvo app with all features...');
  root.render(<App />);

  console.log('✅ Full Equyvo App loaded successfully!');

} catch (error) {
  console.error('❌ Failed to start app:', error);
  document.body.innerHTML = `
    <div style="padding: 20px; background: #ff4444; color: white; font-family: monospace;">
      <h1>❌ App Failed to Start</h1>
      <p>Error: ${error.message}</p>
      <details>
        <summary>Stack Trace</summary>
        <pre>${error.stack}</pre>
      </details>
    </div>
  `;
}