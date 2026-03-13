export default function registerUiWidgetPlugin(ui: {
  registerWidget(definition: {
    id: string;
    slot: "chat.scene.overlay";
    order?: number;
    mount(container: HTMLElement, context: {
      getActiveSessionId(): string | undefined;
    }): () => void;
  }): void;
}) {
  ui.registerWidget({
    id: "widget.test",
    slot: "chat.scene.overlay",
    order: 10,
    mount(container, context) {
      container.textContent = `active=${context.getActiveSessionId() || ""}`;
      container.setAttribute("data-mounted", "true");
      return () => {
        container.setAttribute("data-cleaned", "true");
      };
    },
  });
}
