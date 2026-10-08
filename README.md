# Smart Document Scanner Pro v4

A static browser OCR document scanner for Indian identity/general documents.

## v4 fixes
- Document-aware extraction instead of guessing from arbitrary OCR lines.
- PAN Name extraction prioritizes the value immediately following the `Name` label.
- PAN-specific focused OCR regions for PAN, Name, Father's Name and Date of Birth.
- Mobile Number is returned only when a valid Indian 10-digit number is actually visible in OCR.
- Address is returned only when an explicit address label is present. The scanner no longer invents an address from unrelated OCR text.
- Gender is returned only when a gender/sex value is actually printed in the document. It does not infer gender from a person's photograph.
- PAN, Aadhaar and Date of Birth use dedicated pattern checks.
- Multiple OCR passes and image enhancement remain enabled.
- Camera/upload, editable review, local records and Excel export remain available.

## Important behavior
A PAN card normally contains name, father's name, date of birth and PAN number. It does not normally print a mobile number, residential address or gender. For the PAN image used during testing, those fields should therefore remain blank rather than being guessed.

OCR is not government verification. Always verify extracted information before using it.

## Deployment
Use GitHub Pages with:
- `index.html` in repository root
- `assets/app.js`
- `assets/style.css`
- Branch `main`, folder `/ (root)`
- HTTPS enabled
