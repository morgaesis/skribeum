import { mount, tick } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { hasDesktopRuntime } from "./lib/features/updates";
import { windowReady, windowWarmup } from "./lib/ipc/services";

const target = document.getElementById("app");
if (target === null) {
  throw new Error("mount target #app missing from index.html");
}

const application = mount(App, { target });

async function revealDesktopWindow(): Promise<void> {
  if (!hasDesktopRuntime()) return;
  await tick();
  await windowWarmup();
  await Promise.race([
    document.fonts.ready.then(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    ),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
  await windowReady(performance.now());
}

void revealDesktopWindow().catch(() => {
  void windowReady(performance.now()).catch(() => {});
});

export default application;
