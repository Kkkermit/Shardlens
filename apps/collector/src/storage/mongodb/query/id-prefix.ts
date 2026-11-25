import { type Document, MaxKey, MinKey } from 'mongodb';

/**
 * Documents whose compound `_id` starts with `prefix` (its fields in the order the `_id` has them), whatever its
 * `last` field holds: a range of `_id`, which the `_id` index serves, so collections keyed by app need no index of
 * their own. A plain document: the driver's filter types have no way to say a range of partial compound IDs.
 */
export function idPrefix(prefix: Document, last: string): Document {
  return { _id: { $gte: { ...prefix, [last]: new MinKey() }, $lt: { ...prefix, [last]: new MaxKey() } } };
}
