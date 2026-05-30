/* WikiBrowse — deterministic category → colour mapping + legend tracking.
 *
 * A page belongs to many categories; nodes are coloured by their *primary*
 * (first non-hidden) category. Colours are derived by hashing the category
 * name to a hue, so the same category is always the same colour across sessions
 * without needing a fixed palette.
 */
const Categories = (() => {
  const counts = new Map();   // category -> node count (for the legend)
  const NO_CAT = '(uncategorised)';

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  // Returns an HSL colour inside the theme's neon-on-dark band.
  function colorFor(category) {
    if (!category) return '#3a5a7a'; // --text3, neutral for uncategorised
    const hue = hash(category) % 360;
    return `hsl(${hue}, 70%, 60%)`;
  }

  // Darker fill that pairs with the stroke colorFor().
  function fillFor(category) {
    if (!category) return '#101722';
    const hue = hash(category) % 360;
    return `hsl(${hue}, 45%, 12%)`;
  }

  function track(category) {
    const key = category || NO_CAT;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  function untrack(category) {
    const key = category || NO_CAT;
    const n = (counts.get(key) || 0) - 1;
    if (n <= 0) counts.delete(key); else counts.set(key, n);
  }

  function reset() { counts.clear(); }

  // Sorted by frequency, descending — most-present categories first.
  function legend() {
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => ({
        category,
        count,
        color: category === NO_CAT ? colorFor(null) : colorFor(category),
      }));
  }

  return { colorFor, fillFor, track, untrack, reset, legend, NO_CAT };
})();
