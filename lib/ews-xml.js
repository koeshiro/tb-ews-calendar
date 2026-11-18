// ews-xml.js — EWS XML helpers.
// Pure (no Thunderbird dependencies) so the same code runs in Node for tests.
// In Thunderbird the DOM comes from XMLUtils.parseXML(); in Node a compatible
// mini-DOM is used. Helpers only rely on: node.nodeName, node.childNodes,
// node.getAttribute(name), node.textContent, node.getElementsByTagName(name).

// Thunderbird (ChromeUtils.import) module exports; the Node `module.exports`
// guard at the bottom covers `require()` in tests.
var EXPORTED_SYMBOLS = [
  "NS", "EWS_VERSION", "SOAP_HEADER", "escapeXml", "soapEnvelope",
  "findDesc", "findDescAll", "child", "childText", "attr", "text", "responseStatus"
];

var NS = {
  soap: "http://schemas.xmlsoap.org/soap/envelope/",
  t: "http://schemas.microsoft.com/exchange/services/2006/types",
  m: "http://schemas.microsoft.com/exchange/services/2006/messages",
};

var EWS_VERSION = "Exchange2016";

// RequestServerVersion header, matching the proven Outlook skill transport.
var SOAP_HEADER =
  '<t:RequestServerVersion xmlns:t="' + NS.t + '" Version="' + EWS_VERSION + '"/>';

// --- escaping ---------------------------------------------------------------

function escapeXml(s) {
  if (s === null || s === undefined) {
    return "";
  }
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// --- envelope ---------------------------------------------------------------

// Build a full SOAP 1.1 envelope around a body XML fragment.
function soapEnvelope(bodyXml) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="' + NS.soap +
    '" xmlns:t="' + NS.t +
    '" xmlns:m="' + NS.m + '">' +
    "<soap:Header>" + SOAP_HEADER + "</soap:Header>" +
    "<soap:Body>" + bodyXml + "</soap:Body>" +
    "</soap:Envelope>"
  );
}

// --- DOM helpers (namespace-agnostic, qualified-name based) -----------------

// First descendant (any depth) whose qualified name equals `name`, or null.
function findDesc(root, name) {
  if (!root) {
    return null;
  }
  var nodes = root.getElementsByTagName(name);
  return nodes && nodes.length ? nodes[0] : null;
}

// All descendants with qualified name `name`, as an array.
function findDescAll(root, name) {
  if (!root) {
    return [];
  }
  var nodes = root.getElementsByTagName(name);
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    out.push(nodes[i]);
  }
  return out;
}

// First direct child with qualified name `name` (falls back to descendant).
function child(el, name) {
  if (!el || !el.childNodes) {
    return null;
  }
  for (var i = 0; i < el.childNodes.length; i++) {
    if (el.childNodes[i].nodeName === name) {
      return el.childNodes[i];
    }
  }
  var nodes = el.getElementsByTagName ? el.getElementsByTagName(name) : [];
  return nodes.length ? nodes[0] : null;
}

// Text content of the first child (or descendant) with qualified name `name`.
function childText(el, name) {
  var c = child(el, name);
  return c && c.textContent != null ? String(c.textContent) : null;
}

// Attribute value of an element.
function attr(el, name) {
  if (!el || !el.getAttribute) {
    return null;
  }
  return el.getAttribute(name);
}

// Text content of an element (null-safe).
function text(el) {
  if (!el || el.textContent == null) {
    return null;
  }
  return String(el.textContent);
}

// Find the first element whose LOCAL name matches (prefix-agnostic: this
// gateway prefixes the envelope with s:, responses with m:/t:).
function findByLocalName(root, localName, depth) {
  if (!root || (depth !== undefined && depth > 12)) {
    return null;
  }
  var nodes = root.childNodes || [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.nodeName) {
      var ln = String(n.nodeName).split(":").pop();
      if (ln === localName) {
        return n;
      }
    }
    var found = findByLocalName(n, localName, depth === undefined ? 1 : depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

// Generic EWS response status. Returns { ok, code, message, fault }.
// ResponseCode/MessageText are ELEMENTS in EWS responses (ResponseClass is
// the only attribute); lookups are localName-based because this gateway
// prefixes everything (s:/m:/t:).
function responseStatus(doc) {
  var fault = findByLocalName(doc, "Fault");
  if (fault) {
    var faultCodeEl = findByLocalName(fault, "faultcode") || findByLocalName(fault, "ResponseCode");
    var faultTextEl = findByLocalName(fault, "faultstring") || findByLocalName(fault, "Message");
    return {
      ok: false,
      fault: true,
      code: (faultCodeEl && text(faultCodeEl)) || "SOAPFault",
      message: (faultTextEl && text(faultTextEl)) || "",
    };
  }
  // The first ResponseMessage in the body carries the authoritative status.
  var msgs = findDescAll(doc, "m:ResponseMessages");
  for (var i = 0; i < msgs.length; i++) {
    var message = child(msgs[i], "m:ResponseMessage");
    if (!message) {
      // Some responses nest a *ResponseMessage directly (CreateItemResponseMessage etc).
      var children = message ? [] : (msgs[i].childNodes || []);
      for (var j = 0; j < children.length; j++) {
        if (children[j].nodeName && children[j].nodeName.indexOf("ResponseMessage") >= 0) {
          message = children[j];
          break;
        }
      }
    }
    if (message) {
      var cls = attr(message, "ResponseClass");
      var codeEl = findByLocalName(message, "ResponseCode");
      var textEl = findByLocalName(message, "MessageText");
      var code = (codeEl && text(codeEl)) || attr(message, "ResponseCode");
      return {
        ok: cls === "Success",
        code: code || (cls === "Success" ? "NoError" : "UnknownError"),
        message: (textEl && text(textEl)) || "",
      };
    }
  }
  return { ok: true, code: "NoError", message: "" };
}

// Node test export (ignored in Thunderbird where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    NS: NS,
    EWS_VERSION: EWS_VERSION,
    SOAP_HEADER: SOAP_HEADER,
    escapeXml: escapeXml,
    soapEnvelope: soapEnvelope,
    findDesc: findDesc,
    findDescAll: findDescAll,
    findByLocalName: findByLocalName,
    child: child,
    childText: childText,
    attr: attr,
    text: text,
    responseStatus: responseStatus,
  };
}
