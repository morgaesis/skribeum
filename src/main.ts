import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { hasDesktopRuntime } from "./lib/features/updates";
import { windowReady } from "./lib/ipc/services";

const target = document.getElementById("app");
if (target === null) {
  throw new Error("mount target #app missing from index.html");
}

const application = mount(App, { target });

async function revealDesktopWindow(): Promise<void> {
  if (!hasDesktopRuntime()) return;
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  await windowReady(performance.now());
}

void revealDesktopWindow();

export default application;
