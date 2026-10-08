# Smart Document Scanner Pro v3

A static GitHub Pages document scanner using browser camera/upload + Tesseract OCR.

## Main improvements
- Multiple OCR passes: original, grayscale, contrast, threshold and bright.
- Higher-resolution image preparation.
- Better Indian mobile-number extraction.
- Label-aware name extraction.
- PAN and Aadhaar pattern detection with OCR digit repair.
- DOB, gender and address extraction.
- Editable results before saving.
- IndexedDB local records.
- Excel export.
- Mobile rear-camera preference + camera switching.
- No backend/API key required.

## Important accuracy note
OCR is image recognition, not government verification. Always verify extracted fields before using them.

## Deployment
GitHub Pages:
- `index.html` at repository root
- `assets/app.js`
- `assets/style.css`
- Pages source: `main` + `/ (root)`
- HTTPS enabled

The camera API requires a secure context such as HTTPS or localhost.
