// A linked list to keep track of recently-used-ness
import Yallist from "yallist"

const MAX = Symbol('max')
const LENGTH = Symbol('length')
const LENGTH_CALCULATOR = Symbol('lengthCalculator')
const ALLOW_STALE = Symbol('allowStale')
const MAX_AGE = Symbol('maxAge')
const DISPOSE = Symbol('dispose')
const NO_DISPOSE_ON_SET = Symbol('noDisposeOnSet')
const LRU_LIST = Symbol('lruList')
const CACHE = Symbol('cache')
const UPDATE_AGE_ON_GET = Symbol('updateAgeOnGet')

const naiveLength = () => 1;

export interface Options<K, V> {
  /**
   * The maximum size of the cache, checked by applying the length
   * function to all values in the cache. Not setting this is kind of silly,
   * since that's the whole purpose of this lib, but it defaults to `Infinity`.
   */
  max?: number;

  /**
   * Maximum age in ms. Items are not pro-actively pruned out as they age,
   * but if you try to get an item that is too old, it'll drop it and return
   * undefined instead of giving it to you.
   */
  maxAge?: number;

  /**
   * Function that is used to calculate the length of stored items.
   * If you're storing strings or buffers, then you probably want to do
   * something like `function(n, key){return n.length}`. The default
   * is `function(){return 1}`, which is fine if you want to store
   * `max` like-sized things. The item is passed as the first argument,
   * and the key is passed as the second argument.
   */
  length?(value: V, key?: K): number;

  /**
   * Function that is called on items when they are dropped from the cache.
   * This can be handy if you want to close file descriptors or do other
   * cleanup tasks when items are no longer accessible. Called with `key, value`.
   * It's called before actually removing the item from the internal cache,
   * so if you want to immediately put it back in, you'll have to do that in
   * a `nextTick` or `setTimeout` callback or it won't do anything.
   */
  dispose?(key: K, value: V): void;

  /**
   * By default, if you set a `maxAge`, it'll only actually pull stale items
   * out of the cache when you `get(key)`. (That is, it's not pre-emptively
   * doing a `setTimeout` or anything.) If you set `stale:true`, it'll return
   * the stale value before deleting it. If you don't set this, then it'll
   * return `undefined` when you try to get a stale entry,
   * as if it had already been deleted.
   */
  stale?: boolean;

  /**
   * By default, if you set a `dispose()` method, then it'll be called whenever
   * a `set()` operation overwrites an existing key. If you set this option,
   * `dispose()` will only be called when a key falls out of the cache,
   * not when it is overwritten.
   */
  noDisposeOnSet?: boolean;

  /**
   * When using time-expiring entries with `maxAge`, setting this to `true` will make each
   * item's effective time update to the current time whenever it is retrieved from cache,
   * causing it to not expire. (It can still fall out of cache based on recency of use, of
   * course.)
   */
  updateAgeOnGet?: boolean;
}

// lruList is a yallist where the head is the youngest
// item, and the tail is the oldest.  the list contains the Hit
// objects as the entries.
// Each Hit object has a reference to its Yallist.Node.  This
// never changes.
//
// cache is a Map (or PseudoMap) that matches the keys to
// the Yallist.Node object.
export default class LRUCache<K, V> {

  private [LENGTH_CALCULATOR]: (v: V, k: K) => number;
  private [ALLOW_STALE]: any;
  private [MAX_AGE]: number;
  private [DISPOSE]: any;
  private [NO_DISPOSE_ON_SET]: any;
  private [UPDATE_AGE_ON_GET]: any;
  private [LENGTH]: any;
  private [LRU_LIST]: Yallist<LEntry>;
  private [MAX]: any;
  private [CACHE]: any;

  constructor(options?: Options<K, V>);
  constructor(max: number);
  constructor(options?: number | Options<K, V>) {
    if (typeof options === 'number')
      options = { max: options }

    if (!options)
      options = {}

    if (options.max && (typeof options.max !== 'number' || options.max < 0))
      throw new TypeError('max must be a non-negative number')
    // Kind of weird to have a default max of Infinity, but oh well.
    const max = this[MAX] = options.max || Infinity

    const lc = options.length || naiveLength
    this[LENGTH_CALCULATOR] = (typeof lc !== 'function') ? naiveLength : lc
    this[ALLOW_STALE] = options.stale || false
    if (options.maxAge && typeof options.maxAge !== 'number')
      throw new TypeError('maxAge must be a number')
    this[MAX_AGE] = options.maxAge || 0
    this[DISPOSE] = options.dispose
    this[NO_DISPOSE_ON_SET] = options.noDisposeOnSet || false
    this[UPDATE_AGE_ON_GET] = options.updateAgeOnGet || false
    this.reset()
  }

  // resize the cache when the max changes.
  set max(mL) {
    if (typeof mL !== 'number' || mL < 0)
      throw new TypeError('max must be a non-negative number')

    this[MAX] = mL || Infinity
    trim(this)
  }

  /**
   * Same as Options.max. Resizes the cache when the `max` changes.
   */
  get max(): number {
    return this[MAX]
  }

  set allowStale(allowStale: boolean) {
    this[ALLOW_STALE] = !!allowStale
  }

  /**
 * Same as Options.allowStale.
 */
  get allowStale(): boolean {
    return this[ALLOW_STALE]
  }

  set maxAge(mA) {
    if (typeof mA !== 'number')
      throw new TypeError('maxAge must be a non-negative number')

    this[MAX_AGE] = mA
    trim(this)
  }


  /**
   * Same as Options.maxAge. Resizes the cache when the `maxAge` changes.
   */
  get maxAge(): number {
    return this[MAX_AGE]
  }

  /**
   * Resize the cache when the lengthCalculator changes.
   * Same as Options.length.
   */
  set lengthCalculator(lC: (value: V, key: K) => number) {
    if (typeof lC !== 'function')
      lC = naiveLength

    if (lC !== this[LENGTH_CALCULATOR]) {
      this[LENGTH_CALCULATOR] = lC
      this[LENGTH] = 0
      this[LRU_LIST].forEach((hit: LEntry) => {
        hit.length = this[LENGTH_CALCULATOR](hit.value, hit.key)
        this[LENGTH] += hit.length
      })
    }
    trim(this)
  }
  get lengthCalculator() { return this[LENGTH_CALCULATOR] }

  /**
   * Return total length of objects in cache taking into account `length` options function.
   */
  get length() { return this[LENGTH] }

  /**
     * Return total quantity of objects currently in cache. Note,
     * that `stale` (see options) items are returned as part of this item count.
     */
  get itemCount() { return this[LRU_LIST].length }

  /**
   * The same as `cache.forEach(...)` but items are iterated over in reverse order.
   * (ie, less recently used items are iterated over first.)
   */
  rforEach<T = this>(callbackFn: (this: T, value: V, key: K, cache: this) => void, thisArg?: T): void;
  rforEach(fn: any, thisp: any) {
    thisp = thisp || this
    for (let walker = this[LRU_LIST].tail; walker !== null;) {
      const prev = walker.prev
      forEachStep(this, fn, walker, thisp)
      walker = prev
    }
  }

  /**
   * Just like `Array.prototype.forEach`. Iterates over all the keys in the cache,
   * in order of recent-ness. (Ie, more recently used items are iterated over first.)
   */
  forEach<T = this>(callbackFn: (this: T, value: V, key: K, cache: this) => void, thisArg?: T): void;
  forEach(fn: any, thisp: any) {
    thisp = thisp || this
    for (let walker = this[LRU_LIST].head; walker !== null;) {
      const next = walker.next
      forEachStep(this, fn, walker, thisp)
      walker = next
    }
  }

  /**
   * Return an array of the keys in the cache.
   */
  keys(): K[] {
    return this[LRU_LIST].toArray().map((k: LEntry) => k.key)
  }

  /**
   * Return an array of the values in the cache.
   */
  values(): V[] {
    return this[LRU_LIST].toArray().map((k: LEntry) => k.value)
  }

  /**
     * Clear the cache entirely, throwing away all values.
     */
  reset(): void {
    if (this[DISPOSE] &&
      this[LRU_LIST] &&
      this[LRU_LIST].length) {
      this[LRU_LIST].forEach((hit: LEntry) => this[DISPOSE](hit.key, hit.value))
    }

    this[CACHE] = new Map() // hash of items by key
    this[LRU_LIST] = new Yallist() // list of items in order of use recency
    this[LENGTH] = 0 // length of items in the list
  }

  /**
   * Return an array of the cache entries ready for serialization and usage with `destinationCache.load(arr)`.
   */
  dump(): Array<Entry<K, V>> {
    return this[LRU_LIST].map((hit: LEntry) =>
      isStale(this, hit) ? false : {
        k: hit.key,
        v: hit.value,
        e: hit.now + (hit.maxAge || 0)
      }).toArray().filter((h: any) => h) as any
  }

  dumpLru() {
    return this[LRU_LIST]
  }

  /**
   * Will update the "recently used"-ness of the key. They do what you think.
   * `maxAge` is optional and overrides the cache `maxAge` option if provided.
   */
  set(key: K, value: V, maxAge?: number): boolean {
    maxAge = maxAge || this[MAX_AGE]

    if (maxAge && typeof maxAge !== 'number')
      throw new TypeError('maxAge must be a number')

    const now = maxAge ? Date.now() : 0
    const len = this[LENGTH_CALCULATOR](value, key)

    if (this[CACHE].has(key)) {
      if (len > this[MAX]) {
        del(this, this[CACHE].get(key))
        return false
      }

      const node = this[CACHE].get(key)
      const item = node.value

      // dispose of the old one before overwriting
      // split out into 2 ifs for better coverage tracking
      if (this[DISPOSE]) {
        if (!this[NO_DISPOSE_ON_SET])
          this[DISPOSE](key, item.value)
      }

      item.now = now
      item.maxAge = maxAge
      item.value = value
      this[LENGTH] += len - item.length
      item.length = len
      this.get(key)
      trim(this)
      return true
    }

    const hit = new LEntry(key, value, len, now, maxAge)

    // oversized objects fall out of cache automatically.
    if (hit.length > this[MAX]) {
      if (this[DISPOSE])
        this[DISPOSE](key, value)

      return false
    }

    this[LENGTH] += hit.length
    this[LRU_LIST].unshift(hit)
    this[CACHE].set(key, this[LRU_LIST].head)
    trim(this)
    return true
  }

  /**
 * Check if a key is in the cache, without updating the recent-ness
 * or deleting it for being stale.
 */
  has(key: K): boolean {
    if (!this[CACHE].has(key)) return false
    const hit = this[CACHE].get(key).value
    return !isStale(this, hit)
  }

  /**
 * Will update the "recently used"-ness of the key. They do what you think.
 * `maxAge` is optional and overrides the cache `maxAge` option if provided.
 *
 * If the key is not found, will return `undefined`.
 */
  get(key: K): V | undefined {
    return get(this, key, true)
  }

  /**
 * Returns the key value (or `undefined` if not found) without updating
 * the "recently used"-ness of the key.
 *
 * (If you find yourself using this a lot, you might be using the wrong
 * sort of data structure, but there are some use cases where it's handy.)
 */
  peek(key: K): V | undefined {
    return get(this, key, false)
  }

  pop() {
    const node = this[LRU_LIST].tail
    if (!node)
      return null

    del(this, node)
    return node.value
  }

  /**
   * Deletes a key out of the cache.
   */
  del(key: K): void {
    del(this, this[CACHE].get(key))
  }


  /**
   * Loads another cache entries array, obtained with `sourceCache.dump()`,
   * into the cache. The destination cache is reset before loading new entries
   *
   * @param cacheEntries Obtained from `sourceCache.dump()`
   */
  load(arr: ReadonlyArray<Entry<K, V>>): void {
    // reset the cache
    this.reset()

    const now = Date.now()
    // A previous serialized cache has the most recent items first
    for (let l = arr.length - 1; l >= 0; l--) {
      const hit = arr[l]
      const expiresAt = hit.e || 0
      if (expiresAt === 0)
        // the item was created without expiration in a non aged cache
        this.set(hit.k, hit.v)
      else {
        const maxAge = expiresAt - now
        // dont add already expired items
        if (maxAge > 0) {
          this.set(hit.k, hit.v, maxAge)
        }
      }
    }
  }

  /**
     * Manually iterates over the entire cache proactively pruning old entries.
     */
  prune(): void {
    this[CACHE].forEach((value: any, key: any) => get(this, key, false))
  }
}

const get = (self: any, key: any, doUse: any) => {
  const node = self[CACHE].get(key)
  if (node) {
    const hit = node.value
    if (isStale(self, hit)) {
      del(self, node)
      if (!self[ALLOW_STALE])
        return undefined
    } else {
      if (doUse) {
        if (self[UPDATE_AGE_ON_GET])
          node.value.now = Date.now()
        self[LRU_LIST].unshiftNode(node)
      }
    }
    return hit.value
  }
}

const isStale = (self: any, hit: any) => {
  if (!hit || (!hit.maxAge && !self[MAX_AGE]))
    return false

  const diff = Date.now() - hit.now
  return hit.maxAge ? diff > hit.maxAge
    : self[MAX_AGE] && (diff > self[MAX_AGE])
}

const trim = (self: any) => {
  if (self[LENGTH] > self[MAX]) {
    for (let walker = self[LRU_LIST].tail;
      self[LENGTH] > self[MAX] && walker !== null;) {
      // We know that we're about to delete this one, and also
      // what the next least recently used key will be, so just
      // go ahead and set it now.
      const prev = walker.prev
      del(self, walker)
      walker = prev
    }
  }
}

const del = (self: any, node: any) => {
  if (node) {
    const hit = node.value
    if (self[DISPOSE])
      self[DISPOSE](hit.key, hit.value)

    self[LENGTH] -= hit.length
    self[CACHE].delete(hit.key)
    self[LRU_LIST].removeNode(node)
  }
}

class LEntry {
  constructor(public key: any
    , public value: any
    , public length: any
    , public now: any
    , public maxAge: any) {
    this.maxAge = maxAge || 0
  }
}

const forEachStep = (self: any, fn: any, node: any, thisp: any) => {
  let hit = node.value
  if (isStale(self, hit)) {
    del(self, node)
    if (!self[ALLOW_STALE])
      hit = undefined
  }
  if (hit)
    fn.call(thisp, hit.value, hit.key, self)
}

export interface Entry<K, V> {
  k: K;
  v: V;
  e: number;
}