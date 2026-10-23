// Neon star: floats and flies while Lumio thinks, then explodes into the reply.
const STAR_PATH = "M12 1.5 L14.8 9.2 L22.5 12 L14.8 14.8 L12 22.5 L9.2 14.8 L1.5 12 L9.2 9.2 Z";

export function createStar(label = "Lumio is thinking…") {
  const wrap = document.createElement("div");
  wrap.className = "star-wrap";
  wrap.innerHTML = `
    <div class="neon-star" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>
    </div>
    <span class="star-label"></span>`;
  wrap.querySelector(".star-label").textContent = label;
  return wrap;
}

// Spawns sparks from the star's centre, removes the star, then calls onDone.
export function explodeStar(wrap, onDone) {
  const star = wrap.querySelector(".neon-star");
  const label = wrap.querySelector(".star-label");
  if (!star) {
    wrap.remove();
    onDone?.();
    return;
  }
  if (label) label.style.opacity = "0";

  const r = star.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const count = 34;

  for (let i = 0; i < count; i++) {
    const spark = document.createElement("span");
    spark.className = "spark";
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.25;
    const distance = 70 + Math.random() * 150;
    const hue = Math.random() < 0.5 ? 185 + Math.random() * 15 : 285 + Math.random() * 30; // cyan or magenta
    spark.style.left = `${cx}px`;
    spark.style.top = `${cy}px`;
    spark.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
    spark.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
    spark.style.color = `hsl(${hue} 100% 65%)`;
    spark.style.background = spark.style.color;
    document.body.append(spark);
    spark.addEventListener("animationend", () => spark.remove(), { once: true });
  }

  star.classList.add("boom");
  setTimeout(() => {
    wrap.remove();
    onDone?.();
  }, 650);
}
