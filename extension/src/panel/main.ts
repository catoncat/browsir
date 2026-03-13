import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { initSandboxRelay } from "./utils/sandbox-relay";
import "@incremark/theme/styles.css";
import "./styles.css";

initSandboxRelay();

const app = createApp(App);
app.use(createPinia());
app.mount("#app");
