# Smart Document Scanner

A responsive browser-based document OCR application for mobile phones, tablets, laptops and desktops.

## What it does
1. Opens the device camera (rear camera preferred on mobile).
2. Captures a document or accepts an image upload.
3. Runs OCR in the browser using Tesseract.js.
4. Detects likely Aadhaar / PAN / general documents.
5. Extracts name, date of birth, gender, mobile number, PAN, Aadhaar number and address where visible.
6. Lets the user review/correct OCR output.
7. Saves records locally in IndexedDB.
8. Exports all saved records to an `.xlsx` Excel file.
9. Has light/dark dynamic theme.
10. Responsive UI for mobile and PC.

## Important limitations
- OCR is not document authentication.
- Do not claim that this app verifies an Aadhaar or PAN is genuine.
- Aadhaar secure QR verification is a separate UIDAI process.
- For production handling of Aadhaar/PAN data, implement appropriate consent, access controls, retention/deletion policy, encryption, audit logging and applicable Indian legal/regulatory requirements.
- The default setting masks Aadhaar and PAN identifiers in saved records. Users can explicitly enable full storage for their own authorized workflow.

## Run locally
Because camera APIs normally require a secure context, use HTTPS or localhost.

### Option A: Python
```bash
python -m http.server 8080
```
Then open:
http://localhost:8080

For phone testing, localhost on the phone is different from your PC. Use an HTTPS deployment (recommended) or an HTTPS local tunnel.

### Option B: VS Code
Install the Live Server extension and open `index.html`.

## Publish
### GitHub Pages
1. Create a GitHub repository.
2. Upload `index.html` and the `assets` folder.
3. Enable Pages from Settings → Pages → Deploy from branch.
4. Open the generated HTTPS URL.
5. Camera permission will work because the site is HTTPS.

### Netlify / Vercel
Upload the project folder or connect the GitHub repository. No server is required for this version.

## Production upgrade path
For multi-user/company-wide storage, replace IndexedDB with a secure backend such as Flask/FastAPI + PostgreSQL and implement authentication, encryption, consent, role-based access, audit logs, backups, retention controls and server-side Excel export.
