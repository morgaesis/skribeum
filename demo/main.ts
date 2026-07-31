import { mount } from "svelte";
import App from "./app.svelte";
import "./app.css";

const target = document.getElementById("app");
if (target === null) {
  throw new Error("mount target #app missing from demo/index.html");
}

export default mount(App, { target });
