// Content-based type detection for the document types the legacy upload accepted
// (png, jpg/jpeg, pdf, docx). The extension and the client-sent MIME type are not trusted.
const SIGNATURES = [
  { ext: 'pdf', mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  {
    ext: 'png',
    mime: 'image/png',
    test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    // DOCX is a ZIP container whose entries include "word/" parts.
    test: (b) => b.length >= 4 && b.readUInt32LE(0) === 0x04034b50 && b.includes(Buffer.from('word/')),
  },
];

const EXT_ALIASES = { jpeg: 'jpg' };

export function sniffFile(buffer, originalName = '') {
  const match = SIGNATURES.find((s) => s.test(buffer));
  if (!match) return null;
  const rawExt = (originalName.split('.').pop() || '').toLowerCase();
  const ext = EXT_ALIASES[rawExt] || rawExt;
  // Extension must agree with the detected content.
  if (ext && ext !== match.ext) return null;
  return { ext: match.ext, mime: match.mime };
}
