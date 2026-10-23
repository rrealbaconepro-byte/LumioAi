// Image generator view: prompt → image (stored in Firebase Storage by the backend).
import { callFn } from "./firebase.js";
import { createStar, explodeStar } from "./animation.js";
import { $, esc } from "./utils.js";

export function init() {
  const form = $("image-form");
  const btn = $("image-go");
  const grid = $("image-grid");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = $("image-prompt").value.trim();
    if (!prompt) return;

    btn.disabled = true;
    btn.textContent = "Generating…";

    const card = document.createElement("figure");
    card.className = "img-card";
    const star = createStar("Painting with light…");
    card.append(star);
    grid.prepend(card);

    try {
      const { url } = await callFn("generateImage", { prompt, size: $("image-size").value });
      await new Promise((resolve) => explodeStar(star, resolve));
      card.innerHTML = `
        <img src="${esc(url)}" alt="${esc(prompt)}" />
        <figcaption>
          <span class="small">${esc(prompt)}</span>
          <a class="chip" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open full size</a>
        </figcaption>`;
    } catch (err) {
      console.error(err);
      await new Promise((resolve) => explodeStar(star, resolve));
      card.innerHTML = `<p class="error-text">Could not generate that image: ${esc(err.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate";
    }
  });
}
