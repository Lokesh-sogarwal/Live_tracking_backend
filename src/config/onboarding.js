// Document checklists for driver and operator applications.
//
// PROPOSED DEFAULTS — no checklist existed in the codebase. "license" and "aadhaar" match the
// document types the existing driver-document feature already uses; "offer_letter" is new.
// Confirm these with the business before relying on them. Each application stores a snapshot
// of its checklist, so changing this file never alters applications already in progress.
export const DOCUMENT_TYPES = {
  license: {
    label: 'Driving licence',
    why: 'Shows you are licensed to drive the vehicles in this fleet.',
  },
  aadhaar: {
    label: 'Government ID (Aadhaar)',
    why: 'Confirms that the person applying is who they say they are.',
  },
  offer_letter: {
    label: 'Offer or employment letter',
    why: 'Shows the transport company has hired you for an operations role. A reviewer confirms it with the employer before approval.',
  },
};

export function checklistFor(role, config) {
  if (role === 'driver') return [{ type: 'license', required: true }, { type: 'aadhaar', required: true }];
  if (role === 'operator') {
    return [
      { type: 'aadhaar', required: true },
      { type: 'offer_letter', required: Boolean(config.OPERATOR_OFFER_LETTER_REQUIRED) },
    ];
  }
  return [];
}

export const describeChecklist = (role, config) =>
  checklistFor(role, config).map((d) => ({ type: d.type, required: d.required, ...DOCUMENT_TYPES[d.type] }));
