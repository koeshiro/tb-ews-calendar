// test/xmldom.mjs — minimal XML DOM for Node tests.
// Produces nodes compatible with ews-xml.js helpers:
//   node.nodeName, node.childNodes, node.getAttribute(name),
//   node.textContent, node.getElementsByTagName(name)
// Test-only; the shipped add-on uses Thunderbird's XMLUtils DOM instead.

export class XmlNode {
  constructor(name, attrs) {
    this.nodeName = name;
    this.attributes = attrs || {};
    this.children = []; // element children only
    this._ownText = "";
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }
  get textContent() {
    var s = this._ownText;
    for (var i = 0; i < this.children.length; i++) {
      s += this.children[i].textContent;
    }
    return s;
  }
  get childNodes() {
    return this.children;
  }
  getElementsByTagName(name) {
    var out = [];
    var rec = (node) => {
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (c.nodeName === name) {
          out.push(c);
        }
        rec(c);
      }
    };
    rec(this);
    return out;
  }
}

// Parse an XML string into an XmlNode root. Handles the declaration, CDATA,
// attributes, and self-closing tags. Not a general-purpose parser.
export function parseXml(input) {
  var s = String(input);
  var pos = 0;
  // Skip prolog (<?xml ... ?> and any comments) before the root element.
  while (pos < s.length) {
    var lt = s.indexOf("<", pos);
    if (lt < 0) {
      break;
    }
    s = s.slice(0, pos) + s.slice(lt); // drop leading whitespace/text before root
    pos = lt;
    if (s.startsWith("<?", pos)) {
      var end = s.indexOf("?>", pos);
      pos = end < 0 ? s.length : end + 2;
      s = s.slice(0, pos) + s.slice(pos);
      continue;
    }
    if (s.startsWith("<!--", pos)) {
      var cend = s.indexOf("-->", pos);
      pos = cend < 0 ? s.length : cend + 3;
      s = s.slice(0, pos) + s.slice(pos);
      continue;
    }
    break;
  }

  var root = null;
  var stack = [];
  var top = () => (stack.length ? stack[stack.length - 1] : null);

  function readTagStart() {
    // assumes s[pos] === '<'
    var gt = s.indexOf(">", pos);
    if (gt < 0) {
      return null;
    }
    var raw = s.substring(pos + 1, gt);
    var selfClosing = raw.endsWith("/");
    if (selfClosing) {
      raw = raw.slice(0, -1);
    }
    var parts = raw.split(/\s+/);
    var name = parts[0];
    var attrs = {};
    for (var i = 1; i < parts.length; i++) {
      var eq = parts[i].indexOf("=");
      if (eq > 0) {
        var aName = parts[i].substring(0, eq);
        var aVal = parts[i].substring(eq + 1).replace(/^["']|["']$/g, "");
        attrs[aName] = aVal;
      }
    }
    return { name: name, attrs: attrs, selfClosing: selfClosing, end: gt };
  }

  while (pos < s.length) {
    if (s[pos] === "<") {
      if (s.startsWith("</", pos)) {
        var closeEnd = s.indexOf(">", pos);
        pos = closeEnd < 0 ? s.length : closeEnd + 1;
        stack.pop();
      } else if (s.startsWith("<![CDATA[", pos)) {
        var cdataEnd = s.indexOf("]]>", pos);
        var cdataText = s.substring(pos + 9, cdataEnd < 0 ? s.length : cdataEnd);
        if (top()) {
          top()._ownText += cdataText;
        }
        pos = cdataEnd < 0 ? s.length : cdataEnd + 3;
      } else {
        var tag = readTagStart();
        if (!tag) {
          break;
        }
        var node = new XmlNode(tag.name, tag.attrs);
        if (top()) {
          top().children.push(node);
        } else if (!root) {
          root = node;
        }
        if (!tag.selfClosing) {
          stack.push(node);
        }
        pos = tag.end + 1;
      }
    } else {
      var nextLt = s.indexOf("<", pos);
      if (nextLt < 0) {
        var tail = s.substring(pos);
        if (top()) {
          top()._ownText += tail;
        }
        pos = s.length;
      } else {
        var chunk = s.substring(pos, nextLt);
        if (top() && chunk) {
          top()._ownText += chunk;
        }
        pos = nextLt;
      }
    }
  }

  return root;
}
