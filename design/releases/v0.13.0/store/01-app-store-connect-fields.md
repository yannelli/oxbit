# Oxbit 0.13.1: App Store Connect fields (iOS, en-US)

Created: 2026-10-19. Last updated: 2026-10-19.

Values to enter on each App Store Connect page, in page order. "Current" is what App Store Connect held on 2026-10-19 (read through the API). Character counts are Unicode characters; Keywords and Review Notes limits are bytes, and the text here is ASCII. `store-copy.json` holds the same copy for scripts.

## Copy and paste

Each block holds the exact text for one field. Copy the block and paste it into the field; line breaks are kept. The App Review notes are under [Review notes](#review-notes).

### App Information

#### Name

```text
Oxbit: Code Editor & AI Agent
```

#### Subtitle

```text
Git, SSH, and AI completions
```

#### Privacy Policy URL

```text
https://oxbit.dev/privacy/
```

### Version page

#### Promotional Text

```text
New in 0.13: AI completions as you type, from OpenRouter, your own OpenAI-compatible API, or a local model on your Mac, with model suggestions showing price and scores.
```

#### Description

```text
Oxbit is a code editor for iPhone and iPad with an AI coding agent, Git, and SSH built in. Edit projects on your device, connect to your own servers, and pick up where you left off.

EDIT ON YOUR DEVICE
Open the Oxbit folder or any folder from the Files app. Edit with syntax highlighting, search across the project, quick open, and formatting. Language servers for TypeScript, JavaScript, JSON, YAML, Python, Dockerfile, and shell scripts run on the device for completions, diagnostics, and go to definition. Unsaved drafts and your layout come back after a relaunch.

AI THAT WORKS IN YOUR PROJECT
Ask Oxbit Agent to explain code, find files, or make edits, then review its changes in the editor. Bring your own key for OpenAI, Anthropic, or any OpenAI-compatible service, or sign in with ChatGPT. Dictate messages when typing is slow.

AI COMPLETIONS AS YOU TYPE
Turn on inline completions and accept a suggestion with Tab. Choose OpenRouter, a custom OpenAI-compatible API, a local model running in Ollama or llama.cpp on your Mac, or the agent's own provider. Settings suggests current models with their price, context size, and benchmark score.

GIT BUILT IN
Clone repositories, stage changes, commit, and push and pull without a computer. Browse history, switch branches, and work with stashes. Add GitHub and Gitea accounts and pick one per repository; tokens stay in the Keychain.

SSH AND YOUR COMPUTER
Open folders on a server over SSH and SFTP with keys or passwords from the Keychain. Pair with the Oxbit runtime on your Mac or Linux computer for its terminals, tasks, and language tools, and get a notification or Live Activity when its agent finishes.

PREVIEW AS YOU WRITE
Preview HTML and CSS next to the source and read rendered Markdown. Previews block scripts and remote resources until you allow them.

MADE FOR IPHONE AND IPAD
A key bar adds Tab, Escape, arrows, symbols, undo, and redo above the keyboard. On iPad, split the editor and use hardware keyboard shortcuts. Choose from bundled themes and icon packs.

Oxbit is free and open source, with no account and no ads. Requires iOS or iPadOS 26 or later.
```

#### Keywords

```text
ide,programming,developer,coding,javascript,typescript,python,html,css,markdown,json,yaml,sftp,llm
```

#### Support URL

```text
https://oxbit.dev/support/
```

#### Marketing URL

```text
https://oxbit.dev/
```

#### What's New in This Version

```text
AI completions as you type: choose OpenRouter, a custom OpenAI-compatible API, a local model in Ollama or llama.cpp, or the agent's provider. Settings suggests models with price, context size, and benchmark scores, and Set AI Provider API Key stores the key in the Keychain.

Settings text fields keep every keystroke while you type.
Copy Path confirms what it copied, and Copy Relative Path is new.
Refreshed icons with lighter strokes.
Long workspace names fit on one line in the Explorer.
```

#### Copyright

```text
2026 Ryan Yannelli
```
## App Information (app level)

| Field | Limit | Enter | Current |
| --- | --- | --- | --- |
| Name | 2 to 30 | `Oxbit: Code Editor & AI Agent` (29) | `Oxbit` |
| Subtitle | 30 | `Git, SSH, and AI completions` (28) | `Code editor for iPhone & iPad` |
| Privacy Policy URL | URL | `https://oxbit.dev/privacy/` | same |
| User Privacy Choices URL | URL, optional | leave empty | empty |
| Primary category | | Developer Tools | same |
| Secondary category | | Productivity | same |
| Content Rights | | "Does not contain, show, or access third-party content". Oxbit shows the user's own files and model output from services the user configures. | same |
| Age Rating | | See [Age rating](#age-rating) | legacy 17+ answers |
| License Agreement | | Apple standard EULA | |
| Bundle ID / SKU | locked | `com.yannelli.oxbit` / `oxbit-ios` | |
| Primary language | | English (U.S.) | same |
| EU Digital Services Act | | See [EU DSA trader status](#eu-digital-services-act-trader-status) | |

The home screen name comes from the build's display name and stays "Oxbit". The subtitle above also fits with the store name `Oxbit`.

## Version page (0.13.1)

| Field | Limit | Enter |
| --- | --- | --- |
| Promotional Text | 170 | [Copy and paste](#copy-and-paste) (168) |
| Description | 4000 | [Copy and paste](#copy-and-paste) (2130) |
| Keywords | 100 bytes | `ide,programming,developer,coding,javascript,typescript,python,html,css,markdown,json,yaml,sftp,llm` (98) |
| Support URL | URL | `https://oxbit.dev/support/` |
| Marketing URL | URL | `https://oxbit.dev/` |
| What's New | 4000 | [Copy and paste](#copy-and-paste) (491). App Store Connect asks for it from the second App Store version on. |
| Copyright | | `2026 Ryan Yannelli` |
| Build | | 0.13.1, the first build with the privacy manifest and the AI data sharing prompt. Build 0.13.0 (34) lacks both. |
| Version release | | Manually release this version |
| Phased release | | Off for a first release |

Keywords skip the words already in the name and subtitle (oxbit, code, editor, ai, agent, git, ssh, completions) and contain no other app or company names (guideline 2.3.7).

### Screenshots

| Set in App Store Connect | Files | Pixels | Status |
| --- | --- | --- | --- |
| iPhone 6.9" Display (Dynamic Island large) | `screenshots/iphone-6.9/*.png` | 1320 × 2868 | Upload; covers the large classes |
| iPhone 6.3" Display (Dynamic Island medium) | `screenshots/iphone-6.3/*.png` | 1206 × 2622 | Required |
| iPad 13" Display | `screenshots/ipad-13/*.png` | 2064 × 2752 | Required because the app runs on iPad |
| iPhone Duo outer and inner | none | 1398 × 2034, 2007 × 2853 | Required from April 2027 |

Upload in file-name order; the first three appear in search results. Each set takes 1 to 10 PNG or JPEG images with no alpha channel.

App previews (videos) are optional and not included.

### Creative assets (optional, iOS 27 product page)

| Asset | File | Pixels |
| --- | --- | --- |
| Product page header, 21:9 | `promo/product-page-header.png` | 3840 × 1646 |
| Search results, 3:2 | `promo/search-results.png` | 1920 × 1280 |

## App Review Information

| Field | Enter |
| --- | --- |
| Sign-in required | No |
| Contact | Ryan Yannelli, ryanyannelli@gmail.com, +1 (212) 920-7146 (current values) |
| Notes | [Review notes](#review-notes) (4000 bytes) |
| Attachment | Optional: a screen recording of Agent setup, an inline completion, and a clone and commit |

### Review notes

Fill in the last line with the devices you tested this build on.

```text
Oxbit is a code editor for iPhone and iPad. It needs no account or sign-in and has no in-app purchases, ads, or analytics.

Local editing: open the Oxbit folder under On this device, or choose a folder with Open Folder (Files app picker). Create files from the Explorer. Search, formatting, and the language servers for TypeScript, JavaScript, JSON, YAML, Python, Dockerfile, and shell scripts run on the device in JavaScriptCore. The app downloads no executable code: its content security policy allows scripts from the app bundle only, so extensions on iOS are the ones bundled with the app.

Git: Clone Repository on the workspace screen clones a public HTTPS repository, for example https://github.com/octocat/Hello-World.git, using libgit2 on the device. Commits need an author name and email in Git Accounts and Commit Author. Pushing to a private repository needs the user's own GitHub or Gitea token.

AI features (optional, off until the user adds their own key or endpoint):
- Oxbit Agent (Agent panel) sends the user's prompt and the files it reads to the model service the user picks: OpenAI, Anthropic, an OpenAI-compatible URL, or ChatGPT sign-in.
- AI inline completions (Settings > AI) send the code around the cursor to OpenRouter, a custom OpenAI-compatible API, a local Ollama or llama.cpp server on the user's network, or the agent's provider.
Before the first request to each model service, the app asks "Share data with <service>?" and names what it sends; nothing is sent until the user taps Allow. Oxbit runs no AI service of its own and stores keys in the Keychain. Without a key, these screens open and requests report that a key is needed.

Optional connections: SSH and SFTP workspaces connect to servers the user enters. Connect Runtime pairs with the open source Oxbit runtime (npm install -g @oxbit/cli, then oxbit --lan) on the user's computer; terminals and tasks run on that computer. Notifications and Live Activities report agent status from that runtime.

HTML preview shows local files. JavaScript and remote resources stay off until the user turns them on for that preview. The preview does not navigate to external links.

Tested on: <devices and OS versions>. Requires iOS or iPadOS 26.0 or later.
```

## Age rating

Recommended answers; the result is 4+.

| Group | Item | Answer | Reason |
| --- | --- | --- | --- |
| In-app controls | Parental Controls | No | |
| | Age Assurance | No | |
| Capabilities | Unrestricted Web Access | No | Previews show local files; external links call `window.open` (`packages/features/previews/src/html-preview.tsx:110`) |
| | User-Generated Content | No | Users edit their own files; the iOS app shares nothing with other users |
| | Social Media | No | |
| | Messaging and Chat | No | The agent chat is between the user and a model; the iOS app has no user-to-user messaging |
| | Advertising | No | |
| Mature themes, medical, sexuality, violence | All items | None | |
| Chance-based | Gambling, Simulated Gambling, Contests, Loot Boxes | No / None | |

The current record answers Yes to Unrestricted Web Access, User-Generated Content, and Messaging and Chat, which App Store Connect reports as the legacy 17+ rating. Oxbit does not filter model output from the user's AI service. To rate for that output, keep the answers above and set **Override to Higher Age Rating** to 13+.

## App Privacy

Recommended answer: **Data Not Collected**.

- Oxbit runs no server that stores user data. The push relay forwards notification tokens and text to Apple Push Notification service and keeps neither (privacy policy, "Connections you choose").
- Model APIs, Git remotes, and SSH hosts are services the user configures with their own credentials; the developer has no access to that data.
- The app contains no analytics or crash reporting.

If you count the push relay's sealed handles as collection, declare Identifiers › Device ID for App Functionality, Linked to user: No, Tracking: No.

The App Store Connect API returned 404 for App Privacy, so check its current state in the browser.

## Accessibility Nutrition Labels (voluntary)

Declare for iPhone and iPad after checking each one on a device:

| Feature | Declare | Basis |
| --- | --- | --- |
| Dark Interface | Yes | Dark themes are the default |
| Reduced Motion | Yes, after a device check | `prefers-reduced-motion` turns off animations in `packages/ui/src/workbench.css` |
| VoiceOver, Voice Control, Larger Text, Sufficient Contrast, Differentiate Without Color Alone, Captions, Audio Descriptions | No | Not audited |

## Pricing and Availability

| Field | Enter |
| --- | --- |
| Price | Free (USD 0) |
| Availability | Keep France excluded (see export compliance). On 2026-10-19 the app was set to 10 territories: GBR, CAN, UKR, NLD, ITA, DEU, KOR, POL, DNK, USA. Add the others you want, except France. |
| Make available in new countries automatically | Off, so France is not added later |
| Apple silicon Mac / Apple Vision Pro | Off. A separate macOS app exists, and the iPad build has not been checked on Mac. |
| Tax category | App Store software (default) |

## App Encryption Documentation (export compliance)

The build bundles industry-standard encryption outside Apple's frameworks: OpenSSL through libgit2 (`vendored-openssl`) and russh with aws-lc-rs, AES, and ChaCha20 for SSH. None of it is proprietary.

Apple's table for this case: "Your app uses an industry standard algorithm, not provided within the Apple operating system → Upload your French encryption declaration", required only for distribution in France ([source](https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption)). The App Store Connect API refuses to create a declaration for this case: "Cannot create appEncryptionDeclarations unless either containsProprietaryCryptography is True or containsThirdPartyCryptography and availableOnFrenchStore are both True" (checked 2026-10-19).

Decision (2026-10-19): France stays out of availability, so no declaration or document is needed. `ITSAppUsesNonExemptEncryption` stays `NO`, which keeps CI distribution to TestFlight automatic. Adding France later needs a declaration with `availableOnFrenchStore` and the French document.

## EU Digital Services Act trader status

The app is free, with no purchases, ads, or other income. Declare **not a trader** unless you run Oxbit as a business. A trader declaration publishes an address, phone number, and email on the EU product pages.
