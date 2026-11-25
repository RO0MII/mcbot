'use strict';

/*
 * Flatten Minecraft kick/chat reasons into one readable line.
 *
 * Depending on the protocol version a reason can be a JSON string, a chat
 * component tree, an NBT tag (1.21.5+ sends `anonymousNbt`), or a plain object.
 * Truncate only after flattening — cutting first loses the actual reason.
 */

function stripColor(s) {
  // Modern servers also emit non-legacy `§` control codes (e.g. §\u0080), so
  // drop the marker plus whatever single character follows it.
  return String(s == null ? '' : s).replace(/§[\s\S]/g, '');
}

function chatText(reason) {
  const read = (v, out, depth) => {
    if (v == null || depth > 12) return out;
    if (Buffer.isBuffer(v)) { out.push(v.toString('utf8')); return out; }
    if (typeof v === 'string') {
      const t = v.trim();
      if (!t) return out;
      if (t[0] === '{' || t[0] === '[') {
        try { return read(JSON.parse(t), out, depth + 1); } catch (_) { /* keep raw */ }
      }
      out.push(v);
      return out;
    }
    if (typeof v === 'number' || typeof v === 'boolean') { out.push(String(v)); return out; }
    if (Array.isArray(v)) { v.forEach((x) => read(x, out, depth + 1)); return out; }
    if (typeof v === 'object') {
      // NBT wrappers used by newer kick packets: { name, type, value }.
      if (v.value !== undefined && (v.type !== undefined || v.name !== undefined)) {
        read(v.value, out, depth + 1);
        return out;
      }
      let added = false;
      for (const key of ['text', 'msg', 'message', 'reason', 'translate', 'with', 'extra']) {
        if (v[key] != null) { read(v[key], out, depth + 1); added = true; }
      }
      if (!added) {
        try {
          const raw = JSON.stringify(v);
          if (raw && raw !== '{}' && raw !== '[]') out.push(raw);
        } catch (_) { /* circular or unserializable */ }
      }
    }
    return out;
  };
  return stripColor(read(reason, [], 0).join(' ')).replace(/\s+/g, ' ').trim();
}

module.exports = { chatText, stripColor };
