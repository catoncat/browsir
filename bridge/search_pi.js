const input = document.querySelector('input[aria-label="Search Bookmarks"]');
if (input) {
  input.value = "PI";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
}
