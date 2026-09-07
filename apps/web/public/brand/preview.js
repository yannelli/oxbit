const hero = document.querySelector(".hero");
const buttons = document.querySelectorAll(".themes button");

buttons.forEach((button) => button.addEventListener("click", () => {
  const light = button.dataset.theme === "light";
  hero.dataset.theme = button.dataset.theme;
  document.querySelector("#hero-logo").src = light ? "oxbit-logo-dark.svg" : "oxbit-logo.svg";
  document.querySelector("#hero-mark").src = light ? "oxbit-mark-teal.svg" : "oxbit-mark.svg";
  buttons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
}));
