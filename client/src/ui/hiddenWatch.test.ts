import { describe, expect, it } from "vitest";
import { createHiddenWatch } from "./hiddenWatch.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("createHiddenWatch", () => {
  it("starts seen", () => {
    expect(createHiddenWatch(memoryStorage()).isHidden()).toBe(false);
  });

  it("remembers hiding for the next launch", () => {
    const storage = memoryStorage();
    createHiddenWatch(storage).setHidden(true);

    expect(createHiddenWatch(storage).isHidden()).toBe(true);
  });

  it("remembers showing again", () => {
    const storage = memoryStorage();
    createHiddenWatch(storage).setHidden(true);
    createHiddenWatch(storage).setHidden(false);

    expect(createHiddenWatch(storage).isHidden()).toBe(false);
  });

  it("still works for this page when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const watch = createHiddenWatch(broken);

    watch.setHidden(true);

    expect(watch.isHidden()).toBe(true);
  });

  it("works without storage at all", () => {
    const watch = createHiddenWatch(null);
    watch.setHidden(true);

    expect(watch.isHidden()).toBe(true);
  });
});
