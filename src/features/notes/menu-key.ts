export function menuKeyIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowDown": return (current + 1) % count;
    case "ArrowUp": return (current - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}
