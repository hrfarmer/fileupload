# Apple Shortcut: Upload to fileupload

Apple only permits a Shortcut to be imported directly when its export is signed by Apple (normally via the Shortcuts app or an iCloud share link). Because the API key is private and must not be committed to this repository, the safest setup is this short recipe on the phone. It takes about a minute.

## Build it

1. Open **Shortcuts**, tap **+**, name it `Upload to fileupload`, and open its details.
2. Turn on **Show in Share Sheet** and limit accepted input to **Files**, **Images**, and **Media**.
3. Add **If**: `If Shortcut Input does not have any value`.
4. Inside the If block, add **Select File**, then add **Set Variable** named `Upload File` to the selected file.
5. In the Otherwise block, add **Set Variable** named `Upload File` to `Shortcut Input`.
6. After End If, add a **Text** action containing your API key. Rename its variable to `API Key` if desired.
7. Add **Get Contents of URL** inside a **Repeat with Each** block and expand its options:
   - URL: `https://f.aychar.dev/api/upload`
   - Method: `POST`
   - Headers: `X-API-Key` = the `Text`/`API Key` variable
   - Request Body: `File`
   - File: the current `Repeat Item`
8. Add **Get Dictionary Value**, choose the key `url` from the response.
9. Add **Copy to Clipboard** with that value.
10. Add **Show Result** with: `Uploaded! Link copied: [Dictionary Value]`.

You can now select a photo or file, tap Share, and choose **Upload to fileupload**. Running the Shortcut directly opens the file picker.

## Optional: upload the latest photo from the Home Screen

Duplicate the Shortcut, remove the If/Otherwise input block, and put **Get Latest Photos** (limit 1) before **Get Contents of URL**. Use its result as the `file` form value, then add the duplicate to your Home Screen.
