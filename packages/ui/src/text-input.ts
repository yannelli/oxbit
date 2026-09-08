const textEntry = "input, textarea, [contenteditable]";
const attributes = {
  spellcheck: "false",
  autocorrect: "off",
  autocapitalize: "off",
  autocomplete: "off",
  writingsuggestions: "false",
};

export function installTextInputPolicy(document: Document) {
  const apply = (element: Element) => {
    for (const [name, value] of Object.entries(attributes))
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  const scan = (element: Element) => {
    if (element.matches(textEntry)) apply(element);
    element.querySelectorAll(textEntry).forEach(apply);
  };
  document.documentElement.setAttribute("spellcheck", "false");
  document.documentElement.setAttribute("writingsuggestions", "false");
  scan(document.documentElement);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target as Element;
        if (target.matches(textEntry)) apply(target);
      } else {
        for (const node of record.addedNodes)
          if (node.nodeType === 1) scan(node as Element);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...Object.keys(attributes), "contenteditable"],
  });
  // React can focus a new field before the mutation observer runs.
  const focus = (event: FocusEvent) => {
    const target = event.composedPath()[0] as Element | undefined;
    const entry = target?.closest(textEntry);
    if (entry) apply(entry);
  };
  document.addEventListener("focus", focus, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("focus", focus, true);
  };
}
