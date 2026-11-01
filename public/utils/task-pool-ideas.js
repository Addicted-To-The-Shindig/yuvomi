/**
 * Module: Ideas of a task pool as text (D#2254)
 * Purpose: The two pure steps behind the "one idea per line" field of the pool
 *          dialog - reading the lines, and deciding what a save has to change.
 * Dependencies: none.
 *
 * A pool's ideas are kept as one text field, one idea per line. On save, the
 * lines are held against the ideas the server already has, so that only the
 * difference goes over the wire and what stays keeps its cooldown.
 */

/** One idea per line; empty lines and duplicates are dropped. */
export function parseIdeas(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * What a save has to do, given the ideas the server has and the lines now in the
 * field.
 *
 * A LINE THAT CHANGED IS A RENAME, NOT A DELETE AND AN ADD. The idea behind a line
 * carries its cooldown and the link to the task of its last draw. Deleting it and
 * adding the corrected text would give a fixed typo a clean slate: the new idea
 * could be drawn again while the old task is still open.
 *
 * HOW A REMOVED IDEA AND A NEW LINE ARE PAIRED. First by position: the new line
 * that sits where the removed idea stood (same index in the stored list and in the
 * field) is its successor - that is what editing a line in place looks like, in
 * the middle of the list as much as at its end. What is left over is paired in
 * order, which covers an edit combined with an added or deleted line elsewhere.
 * Whatever finds no partner stays a plain removal or a plain addition. This can
 * misread a deletion plus an unrelated new line as a rename; the cost is
 * conservative - the new line inherits a cooldown or an open task, it is not
 * drawn twice.
 *
 * @param {{id: number, title: string}[]} stored  the ideas of the pool, in order
 * @param {string[]} wanted  the lines of the field, parsed (see parseIdeas)
 * @returns {{
 *   renames: {id: number, title: string}[],
 *   removals: number[],
 *   additions: string[],
 * }}
 */
export function planIdeaChanges(stored, wanted) {
  const wantedSet = new Set(wanted);
  const haveSet = new Set(stored.map((item) => item.title));

  // Stored index -> the idea that has to go, and field index -> the line that is new.
  const gone = new Map();
  stored.forEach((item, index) => { if (!wantedSet.has(item.title)) gone.set(index, item); });
  const fresh = new Map();
  wanted.forEach((title, index) => { if (!haveSet.has(title)) fresh.set(index, title); });

  const renames = [];
  const pairedGone = new Set();
  const pairedFresh = new Set();

  // First by position.
  for (const [index, item] of gone) {
    if (!fresh.has(index)) continue;
    renames.push({ id: item.id, title: fresh.get(index) });
    pairedGone.add(index);
    pairedFresh.add(index);
  }
  // The leftovers in order.
  const goneLeft = [...gone].filter(([index]) => !pairedGone.has(index));
  const freshLeft = [...fresh].filter(([index]) => !pairedFresh.has(index));
  const pairs = Math.min(goneLeft.length, freshLeft.length);
  for (let i = 0; i < pairs; i += 1) {
    renames.push({ id: goneLeft[i][1].id, title: freshLeft[i][1] });
  }

  return {
    renames,
    removals: goneLeft.slice(pairs).map(([, item]) => item.id),
    additions: freshLeft.slice(pairs).map(([, title]) => title),
  };
}
