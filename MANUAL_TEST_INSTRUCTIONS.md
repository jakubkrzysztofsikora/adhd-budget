# Manual MCP Connector Testing Instructions

## 🎯 Objective
Verify that ChatGPT and Claude Web can successfully connect to the ADHD Budget MCP server and invoke tools.

## ✅ Backend Status: READY
All automated backend tests have passed:
- MCP Protocol: ✅ Working
- OAuth Discovery: ✅ Working
- Tool Discovery: ✅ 6 tools available
- Client Registration: ✅ Working with auto redirect URIs
- HTTPS/TLS: ✅ Valid certificate

**Server Endpoint:** `https://adhdbudget.bieda.it/mcp`

---

## 📋 Testing Checklist

### Part 1: ChatGPT Integration Test (15 minutes)

#### Step 1: Access Connector Settings
1. Open: https://chatgpt.com/#settings/Connectors
2. Take screenshot: **chatgpt-connectors-page.png**

#### Step 2: Check Existing Connector
- [ ] Is "ADHD budget" listed in "Enabled connectors"?
- [ ] Does it have a "DEV" badge?
- [ ] Click on it to view details
- [ ] Take screenshot: **chatgpt-connector-details.png**
- [ ] Note the connection status and date

#### Step 3: Reconnect (if needed)
If connector is not properly connected:
1. Click the connector and select "Disconnect"
2. Go to "Advanced settings" → "Developer Mode"
3. Click "Add MCP Server"
4. Enter URL: `https://adhdbudget.bieda.it/mcp`
5. Complete the OAuth authorization flow
6. Take screenshots of:
   - **chatgpt-oauth-consent.png** - OAuth consent screen
   - **chatgpt-connector-connected.png** - Success confirmation

#### Step 4: Test Tool Invocation (CRITICAL)
1. Start a new chat: https://chatgpt.com/
2. Type exactly: "What's my spending summary today from ADHD budget?"
3. Send the message
4. **WATCH CAREFULLY:**
   - Does ChatGPT show "Using ADHD budget" or similar indicator?
   - Does it show tool invocation in progress?
   - Does it return actual data or an error?
5. Take screenshots:
   - **chatgpt-tool-invocation-indicator.png** - Tool usage shown
   - **chatgpt-tool-response.png** - Full response

#### Step 5: Verify Results
- [ ] Tool was invoked (indicator appeared)
- [ ] Response was received (even if mock data)
- [ ] No errors displayed
- [ ] Connector remains connected

**If FAILED:** Note exact error message and take screenshot **chatgpt-error.png**

---

### Part 2: Claude Web Integration Test (15 minutes)

#### Step 1: Access Connector Settings
1. Open Claude Web in browser
2. Navigate to Settings → Connectors (or similar menu)
3. Take screenshot: **claude-connectors-page.png**

#### Step 2: Check Existing Connector
- [ ] Is "ADHD budget" connector listed?
- [ ] What is its connection status?
- [ ] Take screenshot: **claude-connector-status.png**

#### Step 3: Add/Reconnect Connector
1. If not connected, add new connector:
   - URL: `https://adhdbudget.bieda.it/mcp`
2. Complete OAuth flow
3. Take screenshots:
   - **claude-oauth-consent.png**
   - **claude-connector-connected.png**

#### Step 4: Test Tool Invocation (CRITICAL)
1. Start a new conversation
2. Type: "Can you check my spending summary today using ADHD budget?"
3. Send and observe
4. **WATCH FOR:**
   - Tool invocation indicator
   - Data retrieval message
   - Actual response
5. Take screenshots:
   - **claude-tool-invocation.png**
   - **claude-tool-response.png**

#### Step 5: Verify Results
- [ ] Tool was invoked
- [ ] Response received
- [ ] No errors
- [ ] Connection maintained

**If FAILED:** Note error and take screenshot **claude-error.png**

---

## 🐛 Debugging Guide

### Common Issues & Solutions

#### Issue: "invalid_redirect_uri" Error
**Cause:** OAuth redirect URI mismatch
**Solution:**
1. Note the EXACT redirect URI shown in error
2. Report it (it should be auto-added but might be a new variant)
3. Check server logs: `docker logs adhd-budget-mcp-server-1 --tail 50`

#### Issue: Connector Shows "Connected" but Tools Not Invoked
**Possible causes:**
1. OAuth token expired → Try reconnecting
2. Tools not properly registered → Check tools/list response
3. Platform not recognizing tool → Check tool descriptions

**Debug steps:**
1. Disconnect and reconnect connector
2. Check browser DevTools → Network tab for API calls
3. Look for requests to MCP endpoint during chat
4. Check for HTTP error codes (401, 403, 500)

#### Issue: OAuth Flow Fails Completely
**Possible causes:**
1. Client registration failed
2. Authorization endpoint error
3. Token exchange problem

**Debug steps:**
1. Open browser DevTools → Network tab
2. Start OAuth flow
3. Look for requests to:
   - `/oauth/register`
   - `/oauth/authorize`
   - `/oauth/token`
4. Check response codes and error bodies
5. Take screenshots of all error responses

---

## 📊 Success Criteria

### Minimum Requirements for "PASS"
1. ✅ Connector shows as "Connected" with a connection date
2. ✅ Tool invocation indicator appears when requesting spending data
3. ✅ Some response is received (even if mock data)
4. ✅ No "invalid_redirect_uri" errors
5. ✅ No OAuth authorization failures

### Ideal "FULL PASS"
1. ✅ All above minimum requirements
2. ✅ Tool response contains actual/mock spending data
3. ✅ Multiple tool invocations work (try different queries)
4. ✅ Token refresh works (test after waiting 1+ hour)
5. ✅ Reconnection works smoothly

---

## 📝 Results Template

Copy this and fill in your results:

```
## Test Results

**Date:** [YYYY-MM-DD]
**Tester:** [Your Name]

### ChatGPT Test
- Connector Status: [Connected/Not Connected/Error]
- Tool Invocation: [Success/Failed/Not Attempted]
- Error Messages: [None / Describe errors]
- Screenshots: [List filenames]
- Overall: [PASS/FAIL]

### Claude Web Test
- Connector Status: [Connected/Not Connected/Error]
- Tool Invocation: [Success/Failed/Not Attempted]
- Error Messages: [None / Describe errors]
- Screenshots: [List filenames]
- Overall: [PASS/FAIL]

### Summary
The fix [DID / DID NOT] resolve the connector integration issues.

[Additional notes...]
```

---

## 🚀 Quick Test (5 minutes)

If short on time, run this minimal test:

1. **ChatGPT:** Go to connectors, verify "ADHD budget" shows "Connected"
2. **ChatGPT:** Ask about spending, verify tool invocation indicator appears
3. **Claude:** Same two steps
4. **Report:** "Quick test PASSED" or describe failure

---

## 📞 Support

**If tests fail:**
1. Save all screenshots to a folder
2. Export browser DevTools network logs (HAR file)
3. Note exact error messages
4. Check server logs: `docker logs adhd-budget-mcp-server-1`
5. Report findings with evidence

**Server access:**
```bash
ssh root@adhdbudget.bieda.it
docker logs adhd-budget-mcp-server-1 --tail 100
docker logs adhd-budget-mcp-server-1 --follow  # live monitoring
```

---

## ✨ What Should Work Now

Based on the fix (automatic redirect URI inclusion), these should now work:

1. ✅ ChatGPT OAuth flow completes without "invalid_redirect_uri"
2. ✅ Claude Web OAuth flow completes without redirect errors
3. ✅ Both platforms can register as OAuth clients automatically
4. ✅ Tool invocation requests reach the MCP server
5. ✅ Responses are returned to the chat interfaces

**The only unknowns:**
- Are there NEW redirect URI variants we haven't seen?
- Do the platforms have other integration requirements?
- Are there rate limits or other restrictions?

**Time to find out! Good luck with testing! 🎉**
