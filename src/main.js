import { createApp } from "vue";

const view = new URLSearchParams(window.location.search).get("view");
const component = view === "mini" ? import("./MiniWindow.vue") : import("./App.vue");

component.then(({ default: rootComponent }) => {
  createApp(rootComponent).mount("#app");
});
