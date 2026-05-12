import { mkdir, readdir, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { TaskSchema, AssignmentSchema, ReviewRequestSchema, ReviewResponseSchema, BidSchema, type Task } from "./schemas";

const ROOT = process.cwd();
const MARKET = process.env.MARKET_DIR ?? `${ROOT}/market`;
const REPO = process.env.CAMPAIGN_REPO ?? `${ROOT}/repos/playground`;
const STATE_PATH = process.env.CAMPAIGN_STATE ?? `${ROOT}/orchestrator/private/campaign.json`;
const RESERVATIONS_PATH = process.env.RESERVATIONS_PATH ?? `${ROOT}/orchestrator/private/reservations.json`;
const TARGET_TASKS = Number(process.env.CAMPAIGN_TARGET_TASKS ?? "100");
const TICK_MS = Number(process.env.CAMPAIGN_TICK_MS ?? "15000");
const DEADLINE_MIN = Number(process.env.CAMPAIGN_DEADLINE_MIN ?? "7");
const REVIEW_FEE = Number(process.env.CAMPAIGN_REVIEW_FEE ?? "2000");
const RESERVATION = Number(process.env.CAMPAIGN_RESERVATION ?? "500000");

type Spec = { name: string; exportName: string; description: string; tests: string };
type Project = { id: string; title: string; codePath: string; specs: Spec[] };
type ProjectState = { index: number; currentTask?: string; merged: string[]; retries: Record<string, number> };
type CampaignState = { target: number; created: number; projects: Record<string, ProjectState> };

function s(name: string, exportName: string, description: string, tests: string): Spec {
  return { name, exportName, description, tests: tests.trim() + "\n" };
}

const projects: Project[] = [
  {
    id: "strings",
    title: "String utilities",
    codePath: "projects/strings/index.ts",
    specs: [
      s("slugify", "slugify", "Add slugify(input: string): string. Lowercase text, trim it, replace runs of non-alphanumeric characters with '-', and strip leading/trailing dashes.", `
  test("slugifies punctuation and whitespace", () => {
    expect(slugify(" Hello, World! ")).toBe("hello-world");
    expect(slugify("A  B---C")).toBe("a-b-c");
    expect(slugify("***")).toBe("");
  });`),
      s("titleCase", "titleCase", "Add titleCase(input: string): string. Split on whitespace, lowercase words, uppercase first character of each word, and join with single spaces.", `
  test("title-cases words and collapses whitespace", () => {
    expect(titleCase("hello WORLD")).toBe("Hello World");
    expect(titleCase("  multiple   words here ")).toBe("Multiple Words Here");
    expect(titleCase("")).toBe("");
  });`),
      s("truncate", "truncate", "Add truncate(input: string, maxLength: number, suffix?: string): string. If input fits, return it. Otherwise return a string of maxLength including suffix (default '…'). Throw for negative maxLength.", `
  test("truncates with suffix", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 6)).toBe("abcdef");
    expect(truncate("abcdef", 5, "...")).toBe("ab...");
    expect(() => truncate("x", -1)).toThrow();
  });`),
      s("words", "words", "Add words(input: string): string[]. Return alphanumeric word tokens, preserving apostrophes inside words, ignoring punctuation and whitespace.", `
  test("extracts word tokens", () => {
    expect(words("Hello, world! It's 2026.")).toEqual(["Hello", "world", "It's", "2026"]);
    expect(words(" -- ")).toEqual([]);
  });`),
      s("initials", "initials", "Add initials(input: string): string. Use words(input), take the first character of each word, uppercase it, and concatenate.", `
  test("builds initials", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("  hyper text transfer protocol ")).toBe("HTTP");
    expect(initials("")).toBe("");
  });`),
      s("countOccurrences", "countOccurrences", "Add countOccurrences(input: string, needle: string): number. Count non-overlapping occurrences of needle in input. Throw if needle is empty.", `
  test("counts non-overlapping occurrences", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abcabcabc", "abc")).toBe(3);
    expect(countOccurrences("abc", "x")).toBe(0);
    expect(() => countOccurrences("abc", "")).toThrow();
  });`),
      s("padCenter", "padCenter", "Add padCenter(input: string, width: number, fill?: string): string. Pad both sides until length is width; extra char goes on the right. Default fill is space. Throw for empty fill.", `
  test("pads centered", () => {
    expect(padCenter("x", 5)).toBe("  x  ");
    expect(padCenter("x", 4, ".")).toBe(".x..");
    expect(padCenter("abcd", 2)).toBe("abcd");
    expect(() => padCenter("x", 3, "")).toThrow();
  });`),
      s("mask", "mask", "Add mask(input: string, visibleEnd: number, maskChar?: string): string. Replace all but the last visibleEnd characters with maskChar (default '*'). Throw for negative visibleEnd or empty maskChar.", `
  test("masks all but suffix", () => {
    expect(mask("1234567890", 4)).toBe("******7890");
    expect(mask("abc", 10)).toBe("abc");
    expect(mask("abc", 0, "#")).toBe("###");
    expect(() => mask("abc", -1)).toThrow();
  });`),
      s("camelCase", "camelCase", "Add camelCase(input: string): string. Tokenize with words, lowercase first token, capitalize following tokens, and concatenate.", `
  test("converts to camelCase", () => {
    expect(camelCase("hello world")).toBe("helloWorld");
    expect(camelCase("User-ID value")).toBe("userIdValue");
    expect(camelCase("")).toBe("");
  });`),
      s("snakeCase", "snakeCase", "Add snakeCase(input: string): string. Tokenize with words, lowercase tokens, and join with underscores.", `
  test("converts to snake_case", () => {
    expect(snakeCase("hello world")).toBe("hello_world");
    expect(snakeCase("User-ID value")).toBe("user_id_value");
  });`),
      s("kebabCase", "kebabCase", "Add kebabCase(input: string): string. Tokenize with words, lowercase tokens, and join with hyphens.", `
  test("converts to kebab-case", () => {
    expect(kebabCase("hello world")).toBe("hello-world");
    expect(kebabCase("User_ID value")).toBe("user-id-value");
  });`),
      s("escapeRegExp", "escapeRegExp", "Add escapeRegExp(input: string): string. Escape characters with special meaning in JavaScript regular expressions.", `
  test("escapes regexp metacharacters", () => {
    const escaped = escapeRegExp("a+b*c?.[x]");
    expect(new RegExp(escaped).test("a+b*c?.[x]")).toBe(true);
    expect(escaped).toBe("a\\+b\\*c\\?\\.\\[x\\]");
  });`),
      s("parseCsvLine", "parseCsvLine", "Add parseCsvLine(line: string): string[]. Parse one RFC4180-ish CSV line with comma separators, quoted fields, and doubled quotes.", `
  test("parses quoted csv fields", () => {
    expect(parseCsvLine('a,b,"c,d"')).toEqual(["a", "b", "c,d"]);
    expect(parseCsvLine('"a""b",x')).toEqual(['a"b', "x"]);
    expect(parseCsvLine("")).toEqual([""]);
  });`),
      s("stringifyCsvLine", "stringifyCsvLine", "Add stringifyCsvLine(fields: string[]): string. Quote fields containing comma, quote, CR, or LF; double embedded quotes.", `
  test("stringifies csv fields", () => {
    expect(stringifyCsvLine(["a", "b"])).toBe("a,b");
    expect(stringifyCsvLine(["a,b", 'c"d'])).toBe('"a,b","c""d"');
  });`),
      s("escapeHtml", "escapeHtml", "Add escapeHtml(input: string): string. Escape &, <, >, double quote, and single quote to HTML entities.", `
  test("escapes html-sensitive chars", () => {
    expect(escapeHtml('<a href="x&y">it\\'s</a>')).toBe("&lt;a href=&quot;x&amp;y&quot;&gt;it&#39;s&lt;/a&gt;");
  });`),
      s("unescapeHtml", "unescapeHtml", "Add unescapeHtml(input: string): string. Reverse the entities produced by escapeHtml.", `
  test("unescapes known html entities", () => {
    expect(unescapeHtml("&lt;b&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;")).toBe("<b>Tom & Jerry's</b>");
  });`),
      s("wrap", "wrap", "Add wrap(input: string, width: number): string[]. Wrap text into lines not exceeding width when possible, breaking on whitespace. Throw for non-positive width.", `
  test("wraps text into lines", () => {
    expect(wrap("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrap("superlong", 4)).toEqual(["superlong"]);
    expect(() => wrap("x", 0)).toThrow();
  });`),
    ],
  },
  {
    id: "numbers",
    title: "Number/statistics utilities",
    codePath: "projects/numbers/index.ts",
    specs: [
      s("sum", "sum", "Add sum(values: number[]): number. Return the arithmetic sum; [] returns 0.", `test("sums numbers", () => { expect(sum([1, 2, 3])).toBe(6); expect(sum([])).toBe(0); });`),
      s("mean", "mean", "Add mean(values: number[]): number. Return NaN for an empty array.", `test("computes mean", () => { expect(mean([2, 4, 6])).toBe(4); expect(mean([])).toBeNaN(); });`),
      s("median", "median", "Add median(values: number[]): number. Do not mutate input. Return NaN for empty arrays.", `test("computes median without mutation", () => { const xs = [3, 1, 2]; expect(median(xs)).toBe(2); expect(xs).toEqual([3, 1, 2]); expect(median([1, 2, 10, 20])).toBe(6); expect(median([])).toBeNaN(); });`),
      s("minMax", "minMax", "Add minMax(values: number[]): {min:number; max:number} | null. Return null for empty arrays.", `test("finds min and max", () => { expect(minMax([3, -1, 9])).toEqual({ min: -1, max: 9 }); expect(minMax([])).toBeNull(); });`),
      s("gcd", "gcd", "Add gcd(a: number, b: number): number using Euclid's algorithm. Treat inputs by absolute value. gcd(0,0) is 0.", `test("computes gcd", () => { expect(gcd(54, 24)).toBe(6); expect(gcd(-8, 12)).toBe(4); expect(gcd(0, 0)).toBe(0); });`),
      s("lcm", "lcm", "Add lcm(a: number, b: number): number. Use absolute values. If either input is 0, return 0.", `test("computes lcm", () => { expect(lcm(6, 8)).toBe(24); expect(lcm(-3, 7)).toBe(21); expect(lcm(0, 9)).toBe(0); });`),
      s("factorial", "factorial", "Add factorial(n: number): number. Accept non-negative integers only; throw otherwise.", `test("computes factorial", () => { expect(factorial(0)).toBe(1); expect(factorial(5)).toBe(120); expect(() => factorial(-1)).toThrow(); expect(() => factorial(1.5)).toThrow(); });`),
      s("fibonacci", "fibonacci", "Add fibonacci(n: number): number. fibonacci(0)=0, fibonacci(1)=1. Accept non-negative integers only.", `test("computes fibonacci", () => { expect(fibonacci(0)).toBe(0); expect(fibonacci(1)).toBe(1); expect(fibonacci(10)).toBe(55); expect(() => fibonacci(-1)).toThrow(); });`),
      s("roundTo", "roundTo", "Add roundTo(value: number, digits: number): number. digits must be a non-negative integer.", `test("rounds to decimal places", () => { expect(roundTo(1.2345, 2)).toBe(1.23); expect(roundTo(1.235, 2)).toBe(1.24); expect(() => roundTo(1, -1)).toThrow(); });`),
      s("clamp", "clamp", "Add clamp(value: number, min: number, max: number): number. Inclusive range. Throw if min > max.", `test("clamps values", () => { expect(clamp(5, 0, 10)).toBe(5); expect(clamp(-1, 0, 10)).toBe(0); expect(clamp(20, 0, 10)).toBe(10); expect(() => clamp(1, 2, 0)).toThrow(); });`),
      s("lerp", "lerp", "Add lerp(a: number, b: number, t: number): number returning a + (b-a)*t.", `test("linearly interpolates", () => { expect(lerp(0, 10, 0.25)).toBe(2.5); expect(lerp(10, 20, 1)).toBe(20); });`),
      s("mapRange", "mapRange", "Add mapRange(value, inMin, inMax, outMin, outMax): number. Throw when inMin === inMax.", `test("maps ranges", () => { expect(mapRange(5, 0, 10, 0, 100)).toBe(50); expect(mapRange(0.5, 0, 1, 10, 20)).toBe(15); expect(() => mapRange(1, 0, 0, 0, 1)).toThrow(); });`),
      s("variance", "variance", "Add variance(values: number[]): number. Use population variance. Return NaN for empty arrays.", `test("computes population variance", () => { expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBe(4); expect(variance([])).toBeNaN(); });`),
      s("stdDev", "stdDev", "Add stdDev(values: number[]): number. Square root of population variance. Return NaN for empty arrays.", `test("computes std dev", () => { expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2); expect(stdDev([])).toBeNaN(); });`),
      s("percentile", "percentile", "Add percentile(values: number[], p: number): number using sorted linear interpolation where p is 0..100. Do not mutate input.", `test("computes percentile", () => { const xs = [15, 20, 35, 40, 50]; expect(percentile(xs, 0)).toBe(15); expect(percentile(xs, 50)).toBe(35); expect(percentile(xs, 100)).toBe(50); expect(xs).toEqual([15, 20, 35, 40, 50]); expect(() => percentile(xs, -1)).toThrow(); });`),
      s("isPrime", "isPrime", "Add isPrime(n: number): boolean. False for non-integers and values < 2. Test divisors only up to sqrt(n).", `test("detects primes", () => { expect(isPrime(2)).toBe(true); expect(isPrime(97)).toBe(true); expect(isPrime(1)).toBe(false); expect(isPrime(100)).toBe(false); expect(isPrime(2.5)).toBe(false); });`),
      s("range", "range", "Add range(start: number, end: number, step?: number): number[]. Half-open range including start excluding end. Default step is 1 or -1 based on direction. Throw on zero step.", `test("builds numeric ranges", () => { expect(range(0, 5)).toEqual([0,1,2,3,4]); expect(range(5, 0)).toEqual([5,4,3,2,1]); expect(range(0, 10, 3)).toEqual([0,3,6,9]); expect(() => range(0, 5, 0)).toThrow(); });`),
    ],
  },
  {
    id: "arrays",
    title: "Array utilities",
    codePath: "projects/arrays/index.ts",
    specs: [
      s("first", "first", "Add first<T>(items: T[]): T | undefined returning the first element.", `test("gets first", () => { expect(first([1,2,3])).toBe(1); expect(first([])).toBeUndefined(); });`),
      s("last", "last", "Add last<T>(items: T[]): T | undefined returning the last element.", `test("gets last", () => { expect(last([1,2,3])).toBe(3); expect(last([])).toBeUndefined(); });`),
      s("compact", "compact", "Add compact<T>(items: Array<T | null | undefined>): T[] removing only null and undefined, preserving other falsy values.", `test("removes nullish only", () => { expect(compact([0, null, 1, undefined, false, ""])).toEqual([0,1,false,""]); });`),
      s("unique", "unique", "Add unique<T>(items: T[]): T[] preserving first occurrences using SameValueZero semantics.", `test("deduplicates", () => { expect(unique([1,2,1,3,2])).toEqual([1,2,3]); });`),
      s("chunk", "chunk", "Add chunk<T>(items: T[], size: number): T[][]. Throw for non-positive or non-integer size. Do not mutate input.", `test("chunks arrays", () => { expect(chunk([1,2,3,4,5], 2)).toEqual([[1,2],[3,4],[5]]); expect(() => chunk([1], 0)).toThrow(); });`),
      s("flatten", "flatten", "Add flatten<T>(items: Array<T | T[]>): T[] flattening one level only.", `test("flattens one level", () => { expect(flatten([1, [2,3], 4])).toEqual([1,2,3,4]); });`),
      s("partition", "partition", "Add partition<T>(items: T[], pred: (item:T)=>boolean): [T[], T[]] returning matching and non-matching arrays.", `test("partitions arrays", () => { expect(partition([1,2,3,4], x => x % 2 === 0)).toEqual([[2,4],[1,3]]); });`),
      s("groupBy", "groupBy", "Add groupBy<T, K extends PropertyKey>(items: T[], keyFn: (item:T)=>K): Record<K, T[]>.", `test("groups by key", () => { expect(groupBy(["a","bb","c"], x => String(x.length))).toEqual({ "1": ["a","c"], "2": ["bb"] }); });`),
      s("countBy", "countBy", "Add countBy<T, K extends PropertyKey>(items: T[], keyFn: (item:T)=>K): Record<K, number>.", `test("counts by key", () => { expect(countBy(["a","bb","c"], x => String(x.length))).toEqual({ "1": 2, "2": 1 }); });`),
      s("zip", "zip", "Add zip<A,B>(a: A[], b: B[]): Array<[A,B]> truncating to the shorter input.", `test("zips arrays", () => { expect(zip([1,2,3], ["a","b"])).toEqual([[1,"a"],[2,"b"]]); });`),
      s("unzip", "unzip", "Add unzip<A,B>(pairs: Array<[A,B]>): [A[], B[]].", `test("unzips pairs", () => { expect(unzip([[1,"a"],[2,"b"]])).toEqual([[1,2],["a","b"]]); });`),
      s("rotate", "rotate", "Add rotate<T>(items: T[], count: number): T[]. Positive count rotates left; negative rotates right. Do not mutate input.", `test("rotates arrays", () => { const xs = [1,2,3,4]; expect(rotate(xs, 1)).toEqual([2,3,4,1]); expect(rotate(xs, -1)).toEqual([4,1,2,3]); expect(xs).toEqual([1,2,3,4]); });`),
      s("intersection", "intersection", "Add intersection<T>(a: T[], b: T[]): T[] preserving order from a and unique results.", `test("intersects arrays", () => { expect(intersection([1,2,2,3], [2,4])).toEqual([2]); });`),
      s("difference", "difference", "Add difference<T>(a: T[], b: T[]): T[] preserving items from a not in b.", `test("diffs arrays", () => { expect(difference([1,2,3,2], [2])).toEqual([1,3]); });`),
      s("take", "take", "Add take<T>(items: T[], n: number): T[] returning the first n items. Negative n returns [].", `test("takes prefix", () => { expect(take([1,2,3], 2)).toEqual([1,2]); expect(take([1,2], -1)).toEqual([]); });`),
      s("drop", "drop", "Add drop<T>(items: T[], n: number): T[] dropping the first n items. Negative n drops none.", `test("drops prefix", () => { expect(drop([1,2,3], 2)).toEqual([3]); expect(drop([1,2], -1)).toEqual([1,2]); });`),
      s("windowed", "windowed", "Add windowed<T>(items: T[], size: number): T[][]. Return sliding windows of length size. Throw for non-positive size.", `test("creates sliding windows", () => { expect(windowed([1,2,3,4], 3)).toEqual([[1,2,3],[2,3,4]]); expect(windowed([1], 2)).toEqual([]); expect(() => windowed([1], 0)).toThrow(); });`),
    ],
  },
  {
    id: "objects",
    title: "Object utilities",
    codePath: "projects/objects/index.ts",
    specs: [
      s("pick", "pick", "Add pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T,K>.", `test("picks keys", () => { expect(pick({a:1,b:2,c:3}, ["a","c"])).toEqual({a:1,c:3}); });`),
      s("omit", "omit", "Add omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T,K>.", `test("omits keys", () => { expect(omit({a:1,b:2,c:3}, ["b"])).toEqual({a:1,c:3}); });`),
      s("mapValues", "mapValues", "Add mapValues<T, U>(obj: Record<string,T>, fn: (value:T,key:string)=>U): Record<string,U>.", `test("maps values", () => { expect(mapValues({a:1,b:2}, v => v * 2)).toEqual({a:2,b:4}); });`),
      s("filterValues", "filterValues", "Add filterValues<T>(obj: Record<string,T>, pred: (value:T,key:string)=>boolean): Record<string,T>.", `test("filters values", () => { expect(filterValues({a:1,b:2,c:3}, v => v > 1)).toEqual({b:2,c:3}); });`),
      s("fromPairs", "fromPairs", "Add fromPairs<T>(pairs: Array<[string,T]>): Record<string,T>.", `test("builds object from pairs", () => { expect(fromPairs([["a",1],["b",2]])).toEqual({a:1,b:2}); });`),
      s("toPairs", "toPairs", "Add toPairs<T>(obj: Record<string,T>): Array<[string,T]> using Object.keys order.", `test("returns pairs", () => { expect(toPairs({a:1,b:2})).toEqual([["a",1],["b",2]]); });`),
      s("deepGet", "deepGet", "Add deepGet(obj: unknown, path: Array<string|number>, fallback?: unknown): unknown. Return fallback when path cannot be followed.", `test("gets nested values", () => { expect(deepGet({a:{b:[10]}}, ["a","b",0])).toBe(10); expect(deepGet({}, ["x"], "no")).toBe("no"); });`),
      s("deepSet", "deepSet", "Add deepSet(obj: unknown, path: Array<string|number>, value: unknown): unknown. Return a cloned object/array with value set; do not mutate original.", `test("sets nested values immutably", () => { const o:any = {a:{b:1}}; const r:any = deepSet(o, ["a","c"], 2); expect(r).toEqual({a:{b:1,c:2}}); expect(o).toEqual({a:{b:1}}); });`),
      s("hasPath", "hasPath", "Add hasPath(obj: unknown, path: Array<string|number>): boolean.", `test("checks nested paths", () => { expect(hasPath({a:{b:0}}, ["a","b"])).toBe(true); expect(hasPath({a:{}}, ["a","b"])).toBe(false); });`),
      s("invert", "invert", "Add invert(obj: Record<string,string|number|boolean>): Record<string,string>. Values become keys, original keys become string values.", `test("inverts objects", () => { expect(invert({a:1,b:"x"})).toEqual({"1":"a", x:"b"}); });`),
      s("mergeDefaults", "mergeDefaults", "Add mergeDefaults<T extends object>(obj: T, defaults: Partial<T>): T. Fill only undefined/missing keys from defaults.", `test("merges defaults", () => { expect(mergeDefaults({a:1,b:undefined} as any, {a:9,b:2,c:3} as any)).toEqual({a:1,b:2,c:3}); });`),
      s("renameKeys", "renameKeys", "Add renameKeys(obj: Record<string, unknown>, mapping: Record<string,string>): Record<string, unknown>.", `test("renames keys", () => { expect(renameKeys({first_name:"Ada", age:36}, {first_name:"firstName"})).toEqual({firstName:"Ada", age:36}); });`),
      s("removeUndefined", "removeUndefined", "Add removeUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> removing keys whose value is exactly undefined.", `test("removes undefined values", () => { expect(removeUndefined({a:1,b:undefined,c:null})).toEqual({a:1,c:null}); });`),
      s("flattenObject", "flattenObject", "Add flattenObject(obj: Record<string, unknown>, sep?: string): Record<string, unknown> flattening nested plain objects into dot paths.", `test("flattens nested objects", () => { expect(flattenObject({a:{b:1}, c:2})).toEqual({"a.b":1,c:2}); });`),
      s("unflattenObject", "unflattenObject", "Add unflattenObject(obj: Record<string, unknown>, sep?: string): Record<string, unknown> reversing flattenObject for plain object paths.", `test("unflattens path objects", () => { expect(unflattenObject({"a.b":1,c:2})).toEqual({a:{b:1}, c:2}); });`),
      s("sortKeys", "sortKeys", "Add sortKeys<T extends Record<string, unknown>>(obj: T): T returning a new object with keys sorted lexicographically.", `test("sorts keys", () => { expect(Object.keys(sortKeys({b:2,a:1,c:3}))).toEqual(["a","b","c"]); });`),
    ],
  },
  {
    id: "control",
    title: "Control-flow utilities",
    codePath: "projects/control/index.ts",
    specs: [
      s("once", "once", "Add once<F extends (...args:any[])=>any>(fn: F): F. Call fn at most once; subsequent calls return the first result.", `test("calls only once", () => { let n=0; const f = once(() => ++n); expect(f()).toBe(1); expect(f()).toBe(1); expect(n).toBe(1); });`),
      s("memoize", "memoize", "Add memoize<F extends (...args:any[])=>any>(fn: F): F & { clear(): void }. Cache by full argument list; object args by identity; cache undefined too.", `test("memoizes by args and clears", () => { let n=0; const f = memoize((x:number)=>{n++; return x*2;}); expect(f(2)).toBe(4); expect(f(2)).toBe(4); expect(n).toBe(1); f.clear(); expect(f(2)).toBe(4); expect(n).toBe(2); });`),
      s("debounce", "debounce", "Add debounce<F extends (...args:any[])=>void>(fn: F, delayMs: number, setTimeoutFn?, clearTimeoutFn?). Return a function that delays fn until calls stop.", `test("debounces with injected timers", () => { const calls:any[]=[]; let saved:any; const d = debounce((x:number)=>calls.push(x), 10, (fn:any)=>{ saved=fn; return 1 as any; }, () => {}); d(1); d(2); saved(); expect(calls).toEqual([2]); });`),
      s("throttle", "throttle", "Add throttle<F extends (...args:any[])=>void>(fn: F, intervalMs: number, now?:()=>number). Leading-edge throttle; ignore calls within interval.", `test("throttles by time", () => { let t=0; const calls:number[]=[]; const f = throttle((x:number)=>calls.push(x), 10, () => t); f(1); f(2); t=10; f(3); expect(calls).toEqual([1,3]); });`),
      s("retry", "retry", "Add async retry<T>(fn:(attempt:number)=>Promise<T>|T, options:{retries:number; delayMs?:number; sleep?:(ms:number)=>Promise<void>}): Promise<T>.", `test("retries until success", async () => { let n=0; const r = await retry(async (attempt)=>{ n++; if (attempt < 2) throw new Error("x"); return "ok"; }, {retries:3}); expect(r).toBe("ok"); expect(n).toBe(3); });`),
      s("timeout", "withTimeout", "Add withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T>. Reject when timeout wins.", `test("resolves fast promise and rejects timeout", async () => { await expect(withTimeout(Promise.resolve(1), 50)).resolves.toBe(1); await expect(withTimeout(new Promise(()=>{}), 1, "too slow")).rejects.toThrow("too slow"); });`),
      s("defer", "defer", "Add defer<T>(): { promise: Promise<T>; resolve(value:T): void; reject(error:unknown): void }.", `test("creates deferred", async () => { const d = defer<number>(); d.resolve(7); await expect(d.promise).resolves.toBe(7); });`),
      s("sleep", "sleep", "Add sleep(ms: number): Promise<void>. Resolve after ms using setTimeout; throw for negative ms.", `test("sleep accepts zero and rejects negative", async () => { await expect(sleep(0)).resolves.toBeUndefined(); await expect(sleep(-1)).rejects.toThrow(); });`),
      s("semaphore", "Semaphore", "Add Semaphore class with constructor(max:number), acquire(): Promise<()=>void>. At most max acquired permits at a time; release by calling returned function.", `test("semaphore limits concurrency", async () => { const s = new Semaphore(1); const release1 = await s.acquire(); let acquired=false; const p = s.acquire().then(r => { acquired=true; r(); }); await Promise.resolve(); expect(acquired).toBe(false); release1(); await p; expect(acquired).toBe(true); });`),
      s("pLimit", "pLimit", "Add pLimit(concurrency: number): <T>(fn:()=>Promise<T>|T)=>Promise<T>. Run at most concurrency tasks at once.", `test("limits concurrency", async () => { const limit = pLimit(1); const order:string[]=[]; const a = limit(async()=>{ order.push("a"); return 1; }); const b = limit(async()=>{ order.push("b"); return 2; }); expect(await Promise.all([a,b])).toEqual([1,2]); expect(order).toEqual(["a","b"]); });`),
      s("eventEmitter", "EventEmitter", "Add EventEmitter<Events> class with on/off/once/emit/listenerCount/clear.", `test("emits and once", () => { const ee = new EventEmitter<{ping:[number]}>(); const seen:number[]=[]; ee.once("ping", n=>seen.push(n)); expect(ee.emit("ping", 1)).toBe(true); expect(ee.emit("ping", 2)).toBe(false); expect(seen).toEqual([1]); });`),
      s("queue", "Queue", "Add Queue<T> class with enqueue, dequeue, peek, clear, and size getter. FIFO behavior.", `test("queues fifo", () => { const q = new Queue<number>(); q.enqueue(1); q.enqueue(2); expect(q.peek()).toBe(1); expect(q.dequeue()).toBe(1); expect(q.dequeue()).toBe(2); expect(q.dequeue()).toBeUndefined(); });`),
      s("priorityQueue", "PriorityQueue", "Add PriorityQueue<T> class taking comparator (a,b)=>number. enqueue item, dequeue smallest by comparator, size getter.", `test("priority queue dequeues sorted", () => { const q = new PriorityQueue<number>((a,b)=>a-b); q.enqueue(3); q.enqueue(1); q.enqueue(2); expect([q.dequeue(), q.dequeue(), q.dequeue()]).toEqual([1,2,3]); });`),
      s("ttlCache", "TTLCache", "Add TTLCache<K,V> class with ttlMs and optional now function. Implement set/get/has/delete/clear/size and expire observed entries.", `test("expires entries", () => { let now=0; const c = new TTLCache<string,number>(10, () => now); c.set("a",1); expect(c.get("a")).toBe(1); now=11; expect(c.get("a")).toBeUndefined(); expect(c.size).toBe(0); });`),
      s("batch", "batch", "Add batch<T,R>(items:T[], size:number, fn:(chunk:T[])=>Promise<R>|R): Promise<R[]> processing chunks sequentially. Throw for invalid size.", `test("batches sequentially", async () => { const seen:number[][]=[]; const r = await batch([1,2,3,4,5], 2, xs => { seen.push(xs); return xs.length; }); expect(seen).toEqual([[1,2],[3,4],[5]]); expect(r).toEqual([2,2,1]); });`),
      s("pipe", "pipe", "Add pipe(value, ...fns) applying functions left-to-right and returning final value.", `test("pipes values", () => { expect(pipe(2, x=>x+1, x=>x*3)).toBe(9); });`),
      s("compose", "compose", "Add compose(...fns) composing functions right-to-left.", `test("composes functions", () => { const f = compose((x:number)=>x+1, (x:number)=>x*3); expect(f(2)).toBe(7); });`),
    ],
  },
  {
    id: "data",
    title: "Data parsing/formatting utilities",
    codePath: "projects/data/index.ts",
    specs: [
      s("parseBool", "parseBool", "Add parseBool(input: string): boolean | null. Accept true/false, yes/no, 1/0, on/off case-insensitively; otherwise null.", `test("parses booleans", () => { expect(parseBool("YES")).toBe(true); expect(parseBool("off")).toBe(false); expect(parseBool("maybe")).toBeNull(); });`),
      s("parseNumberList", "parseNumberList", "Add parseNumberList(input: string): number[]. Split on commas/whitespace, ignore empty tokens, throw if any token is not finite number.", `test("parses number lists", () => { expect(parseNumberList("1, 2  3")).toEqual([1,2,3]); expect(parseNumberList("")).toEqual([]); expect(() => parseNumberList("1,x")).toThrow(); });`),
      s("parseKeyValueLines", "parseKeyValueLines", "Add parseKeyValueLines(input: string): Record<string,string>. Parse non-empty KEY=VALUE lines, trimming keys/values and ignoring # comments.", `test("parses key value lines", () => { expect(parseKeyValueLines("# hi\na = 1\nb=two\n")).toEqual({a:"1", b:"two"}); });`),
      s("stringifyKeyValueLines", "stringifyKeyValueLines", "Add stringifyKeyValueLines(obj: Record<string,string>): string. Sort keys and output key=value lines joined by \n, ending with \n for non-empty objects.", `test("stringifies key value lines", () => { expect(stringifyKeyValueLines({b:"2", a:"1"})).toBe("a=1\nb=2\n"); expect(stringifyKeyValueLines({})).toBe(""); });`),
      s("parseCookie", "parseCookie", "Add parseCookie(header: string): Record<string,string>. Parse Cookie header pairs separated by ';', trimming whitespace and decoding percent escapes.", `test("parses cookies", () => { expect(parseCookie("a=1; theme=dark%20mode")).toEqual({a:"1", theme:"dark mode"}); });`),
      s("stringifyCookie", "stringifyCookie", "Add stringifyCookie(obj: Record<string,string>): string. Sort keys, encode names/values, join with '; '.", `test("stringifies cookies", () => { expect(stringifyCookie({theme:"dark mode", a:"1"})).toBe("a=1; theme=dark%20mode"); });`),
      s("parseQueryString", "parseQueryString", "Add parseQueryString(q: string): Record<string,string|string[]> accepting optional leading '?' and repeated keys as arrays.", `test("parses query strings", () => { expect(parseQueryString("?a=1&tag=x&tag=y")).toEqual({a:"1", tag:["x","y"]}); expect(parseQueryString("debug")).toEqual({debug:""}); });`),
      s("stringifyQuery", "stringifyQuery", "Add stringifyQuery(obj: Record<string,string|string[]|null|undefined>): string. Sort keys, repeat arrays, skip null/undefined.", `test("stringifies query strings", () => { expect(stringifyQuery({b:"two words", a:["1","2"], c:null})).toBe("a=1&a=2&b=two%20words"); });`),
      s("base64UrlEncode", "base64UrlEncode", "Add base64UrlEncode(input: string): string using UTF-8, URL-safe alphabet, and no padding.", `test("encodes base64url", () => { expect(base64UrlEncode("hello?")).toBe("aGVsbG8_"); });`),
      s("base64UrlDecode", "base64UrlDecode", "Add base64UrlDecode(input: string): string reversing base64UrlEncode.", `test("decodes base64url", () => { expect(base64UrlDecode("aGVsbG8_")).toBe("hello?"); });`),
      s("parseJsonSafe", "parseJsonSafe", "Add parseJsonSafe(input: string): { ok: true; value: unknown } | { ok: false; error: string }.", `test("parses json safely", () => { expect(parseJsonSafe('{"a":1}')).toEqual({ok:true, value:{a:1}}); expect(parseJsonSafe('{bad').ok).toBe(false); });`),
      s("stableStringify", "stableStringify", "Add stableStringify(value: unknown): string. JSON stringify objects with lexicographically sorted keys recursively.", `test("stable stringifies objects", () => { expect(stableStringify({b:2,a:{d:4,c:3}})).toBe('{"a":{"c":3,"d":4},"b":2}'); });`),
      s("parseAcceptLanguage", "parseAcceptLanguage", "Add parseAcceptLanguage(header: string): Array<{tag:string; q:number}> sorted by descending q, default q=1.", `test("parses accept-language", () => { expect(parseAcceptLanguage("fr-CA, fr;q=0.8, en;q=0.5")).toEqual([{tag:"fr-CA", q:1}, {tag:"fr", q:0.8}, {tag:"en", q:0.5}]); });`),
      s("formatBytes", "formatBytes", "Add formatBytes(bytes: number, decimals?: number): string using binary units B, KB, MB, GB, TB. Trim trailing zeroes.", `test("formats bytes", () => { expect(formatBytes(0)).toBe("0 B"); expect(formatBytes(1536, 1)).toBe("1.5 KB"); expect(formatBytes(1024**2)).toBe("1 MB"); });`),
      s("parseDuration", "parseDuration", "Add parseDuration(input: string): number. Parse compound ms/s/m/h/d integer units like '1h30m'. Return NaN for invalid input or repeated units.", `test("parses durations", () => { expect(parseDuration("1h30m")).toBe(5400000); expect(parseDuration("500ms")).toBe(500); expect(parseDuration("1h2h")).toBeNaN(); });`),
      s("formatDuration", "formatDuration", "Add formatDuration(ms: number): string. Format non-negative integer milliseconds into compact d/h/m/s/ms units, omitting zero units except 0ms.", `test("formats durations", () => { expect(formatDuration(0)).toBe("0ms"); expect(formatDuration(90061005)).toBe("1d1h1m1s5ms"); expect(() => formatDuration(-1)).toThrow(); });`),
    ],
  },
];

function projectById(id: string): Project {
  const p = projects.find((p) => p.id === id);
  if (!p) throw new Error(`unknown project ${id}`);
  return p;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return await Bun.file(path).json(); } catch { return fallback; }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(data, null, 2));
}

async function listJson(dir: string): Promise<string[]> {
  try { return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
}

async function loadState(): Promise<CampaignState> {
  const fresh: CampaignState = { target: TARGET_TASKS, created: 0, projects: {} };
  for (const p of projects) fresh.projects[p.id] = { index: 0, merged: [], retries: {} };
  const state = await readJson<CampaignState>(STATE_PATH, fresh);
  state.target ??= TARGET_TASKS;
  state.created ??= 0;
  state.projects ??= {};
  for (const p of projects) state.projects[p.id] ??= { index: 0, merged: [], retries: {} };
  return state;
}

async function saveState(state: CampaignState): Promise<void> {
  await writeJson(STATE_PATH, state);
}

async function nextTaskId(): Promise<string> {
  let max = 0;
  for (const f of await listJson(`${MARKET}/tasks`)) {
    const m = /^task-(\d+)\.json$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `task-${String(max + 1).padStart(3, "0")}`;
}

async function taskStatus(taskId: string): Promise<Task["status"] | null> {
  try { return TaskSchema.parse(await Bun.file(`${MARKET}/tasks/${taskId}.json`).json()).status; }
  catch { return null; }
}

async function campaignBidCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const f of await listJson(`${MARKET}/bids`)) {
    try {
      const b = BidSchema.parse(await Bun.file(`${MARKET}/bids/${f}`).json());
      counts.set(b.task_id, (counts.get(b.task_id) ?? 0) + 1);
    } catch {}
  }
  return counts;
}

async function countedCampaignTasks(): Promise<number> {
  const bidCounts = await campaignBidCounts();
  let count = 0;
  for (const f of await listJson(`${MARKET}/tasks`)) {
    try {
      const t = TaskSchema.parse(await Bun.file(`${MARKET}/tasks/${f}`).json());
      if (t.posted_by !== "campaign") continue;
      if (t.status === "expired" && (bidCounts.get(t.id) ?? 0) === 0) continue;
      count++;
    } catch {}
  }
  return count;
}

async function latestLgtm(taskId: string): Promise<{ agent: string; seq: number; branch: string } | null> {
  const responses = [] as any[];
  for (const f of await listJson(`${MARKET}/review_responses`)) {
    try {
      const r = ReviewResponseSchema.parse(await Bun.file(`${MARKET}/review_responses/${f}`).json());
      if (r.task_id === taskId && r.verdict === "lgtm") responses.push(r);
    } catch {}
  }
  responses.sort((a, b) => b.seq - a.seq);
  for (const r of responses) {
    const reqPath = `${MARKET}/review_requests/${r.task_id}-${r.agent}-${r.seq}.json`;
    try {
      const req = ReviewRequestSchema.parse(await Bun.file(reqPath).json());
      return { agent: r.agent, seq: r.seq, branch: req.branch };
    } catch {}
  }
  return null;
}

async function run(cmd: string[], cwd = ROOT): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

async function gitCommit(paths: string[], message: string): Promise<void> {
  await run(["git", "add", ...paths], REPO);
  const status = await run(["git", "status", "--porcelain", "--", ...paths], REPO);
  if (!status.out.trim()) return;
  const commit = await run(["git", "commit", "-m", message], REPO);
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.err || commit.out}`);
}

function testPath(project: Project, specIndex: number, spec: Spec): string {
  return `tests/campaign/${project.id}/${String(specIndex + 1).padStart(3, "0")}-${spec.name}.test.ts`;
}

async function writeSpecTest(project: Project, specIndex: number, spec: Spec): Promise<string> {
  const rel = testPath(project, specIndex, spec);
  const path = `${REPO}/${rel}`;
  await mkdir(dirname(path), { recursive: true });
  const imports = spec.exportName === "timeout" ? "withTimeout" : spec.exportName;
  const content = `import { describe, expect, test } from "bun:test";\nimport { ${imports} } from "../../../projects/${project.id}/index";\n\ndescribe("${project.id}/${spec.name}", () => {\n${spec.tests}\n});\n`;
  await Bun.write(path, content);
  await gitCommit([rel], `campaign(${project.id}): add ${spec.name} tests`);
  return rel;
}

async function loadReservations(): Promise<Record<string, number>> {
  return readJson<Record<string, number>>(RESERVATIONS_PATH, {});
}

async function postTask(project: Project, specIndex: number, state: CampaignState): Promise<string> {
  const spec = project.specs[specIndex];
  const relTest = await writeSpecTest(project, specIndex, spec);
  const taskId = await nextTaskId();
  const now = new Date();
  const task = TaskSchema.parse({
    id: taskId,
    description:
      `[campaign:${project.id} step ${specIndex + 1}/${project.specs.length}] ${project.title}. ` +
      `Extend '${project.codePath}' by implementing/exporting ${spec.exportName}. ${spec.description} ` +
      `Do not break prior campaign tests for this project. Tests in ${relTest} and prior ${project.id} campaign tests must pass.`,
    repo: REPO,
    base_branch: "main",
    review_fee: REVIEW_FEE,
    deterministic_checks: [{ type: "command", cmd: `bun test tests/campaign/${project.id}/*.test.ts`, must_pass: true }],
    subjective_criteria: `Keep the implementation minimal and maintain existing exports in ${project.codePath}.`,
    status: "open",
    posted_by: "campaign",
    posted_at: now.toISOString(),
    deadline_at: new Date(now.getTime() + DEADLINE_MIN * 60_000).toISOString(),
  });
  await writeJson(`${MARKET}/tasks/${taskId}.json`, task);
  const reservations = await loadReservations();
  reservations[taskId] = RESERVATION;
  await writeJson(RESERVATIONS_PATH, reservations);
  state.created++;
  console.log(`[campaign] posted ${taskId} ${project.id}/${spec.name} (${state.created}/${state.target})`);
  return taskId;
}

async function mergeCompleted(project: Project, taskId: string, state: ProjectState): Promise<boolean> {
  if (state.merged.includes(taskId)) return true;
  const lgtm = await latestLgtm(taskId);
  if (!lgtm) return false;
  const workDir = `${ROOT}/agents/${lgtm.agent}/sandbox/work/${taskId}`;
  const src = `${workDir}/projects/${project.id}`;
  const dst = `${REPO}/projects/${project.id}`;
  if (!existsSync(src)) {
    console.warn(`[campaign] ${taskId}: cannot merge, missing ${src}`);
    return false;
  }
  await mkdir(dirname(dst), { recursive: true });
  await rm(dst, { recursive: true, force: true });
  await cp(src, dst, { recursive: true });
  await gitCommit([`projects/${project.id}`], `campaign(${project.id}): merge ${taskId}`);
  state.merged.push(taskId);
  console.log(`[campaign] merged ${taskId} from ${lgtm.agent}`);
  return true;
}

async function tick(): Promise<void> {
  await mkdir(`${MARKET}/tasks`, { recursive: true });
  const state = await loadState();
  let changed = false;

  const countedCreated = await countedCampaignTasks();
  if (state.created !== countedCreated) {
    console.log(`[campaign] effective created count ${countedCreated}/${state.target} (was ${state.created}; no-bid expired tasks do not count)`);
    state.created = countedCreated;
    changed = true;
  }
  const bidCounts = await campaignBidCounts();

  for (const project of projects) {
    const ps = state.projects[project.id];
    if (ps.index >= project.specs.length) continue;

    if (ps.currentTask) {
      const status = await taskStatus(ps.currentTask);
      if (status === "completed") {
        const merged = await mergeCompleted(project, ps.currentTask, ps);
        if (!merged) continue;
        ps.index++;
        ps.currentTask = undefined;
        changed = true;
      } else if (status === "expired") {
        const stageKey = String(ps.index);
        ps.retries[stageKey] = (ps.retries[stageKey] ?? 0) + 1;
        const bids = bidCounts.get(ps.currentTask) ?? 0;
        const countNote = bids === 0 ? "; no bids, not counted toward target" : `; ${bids} bid(s), counted toward target`;
        console.log(`[campaign] ${ps.currentTask} expired${countNote}; reposting ${project.id} step ${ps.index + 1} (retry ${ps.retries[stageKey]})`);
        ps.currentTask = undefined;
        changed = true;
      } else if (status === "open" || status === "assigned") {
        continue;
      } else if (status === null) {
        console.warn(`[campaign] missing task ${ps.currentTask}; clearing current task`);
        ps.currentTask = undefined;
        changed = true;
      }
    }

    if (!ps.currentTask && ps.index < project.specs.length && state.created < state.target) {
      ps.currentTask = await postTask(project, ps.index, state);
      changed = true;
    }
  }

  if (changed) await saveState(state);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`Usage: bun orchestrator/campaign.ts [--once]\n\nPosts up to ${TARGET_TASKS} sequential campaign tasks across ${projects.length} projects.\nNext project step is posted only after the previous step reaches LGTM and is merged into the playground repo.`);
    return;
  }
  const once = process.argv.includes("--once");
  await tick();
  if (once) return;
  console.log(`[campaign] running; tick ${TICK_MS}ms, target ${TARGET_TASKS}`);
  setInterval(() => { tick().catch((e) => console.error("[campaign] tick failed", e)); }, TICK_MS);
  await new Promise(() => {});
}

if (import.meta.main) await main();
