import { describe, expect, it } from "vitest";
import { createVoteMemory } from "./voteMemory.js";

/** An in-memory stand-in for localStorage. */
function fakeStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

describe("vote memory", () => {
  it("asks a user who never answered", () => {
    expect(createVoteMemory(fakeStorage()).hasPassed("42")).toBe(false);
  });

  it("remembers a user who got through, across launches", () => {
    const storage = fakeStorage();
    createVoteMemory(storage).remember("42");

    expect(createVoteMemory(storage).hasPassed("42")).toBe(true);
  });

  it("keeps each user's answer apart", () => {
    const memory = createVoteMemory(fakeStorage());
    memory.remember("42");

    expect(memory.hasPassed("7")).toBe(false);
  });

  it("asks again after the user logs out", () => {
    const memory = createVoteMemory(fakeStorage());
    memory.remember("42");
    memory.remember("7");

    memory.forget("42");

    expect(memory.hasPassed("42")).toBe(false);
    expect(memory.hasPassed("7")).toBe(true);
  });

  it("always asks when there is no storage to remember with", () => {
    const memory = createVoteMemory(null);
    memory.remember("42");

    expect(memory.hasPassed("42")).toBe(false);
  });

  it("always asks when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const memory = createVoteMemory(broken);

    expect(() => memory.remember("42")).not.toThrow();
    expect(memory.hasPassed("42")).toBe(false);
  });
});
