import "./style.css";

const root = document.querySelector<HTMLElement>("[data-article-slug]");
const editor = document.querySelector<HTMLTextAreaElement>("[data-article-body]");
const jumpForm = document.querySelector<HTMLFormElement>("[data-jump-form]");
const saveButton = document.querySelector<HTMLButtonElement>("[data-save-article]");
const status = document.querySelector<HTMLElement>("[data-save-status]");

if (jumpForm) {
  jumpForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(jumpForm);
    const slug = String(form.get("slug") ?? "").trim().toLowerCase();
    if (!slug) return;
    window.location.assign(`/wiki/${encodeURIComponent(slug)}`);
  });
}

if (root && editor && saveButton && status) {
  let clean = editor.value;
  editor.addEventListener("input", () => {
    status.textContent = editor.value === clean ? "Saved" : "Unsaved changes";
  });

  saveButton.addEventListener("click", async () => {
    const slug = root.dataset.articleSlug ?? "home";
    saveButton.disabled = true;
    status.textContent = "Saving...";

    try {
      const response = await fetch(`/api/articles?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: editor.value,
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      clean = editor.value;
      status.textContent = "Saved";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Save failed";
    } finally {
      saveButton.disabled = false;
    }
  });
}
