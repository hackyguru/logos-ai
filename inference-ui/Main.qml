import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

Item {
    id: root
    width: 640
    height: 860

    property int    deliveryStatus: 0
    property var    exchanges: []
    property string myId: ""
    property string currentRoom: "agora"
    property bool   identityInit: false
    property bool   identityLocked: false
    property string identityFp: ""
    property string identityBackend: ""
    property string freshMnemonic: ""   // held only while the reveal popup is open
    property var    providers: []       // verified roster from signed announces
    property bool   requireEncryption: false
    property string preferredProvider: ""   // "" = auto
    property string modelFilter: ""         // "" = any model
    property bool   trustedOnly: false      // whitelist enforcement
    property int    trustedCount: 0

    // ── LEZ wallet (payment source for lez/paid providers) ───────────
    property bool   walletHasWallet: false  // a wallet exists on disk
    property bool   walletOpen: false       // LEZ side is open (can pay)
    property string walletPrivBal: "…"      // shielded balance we pay from
    property string walletPubBal: "…"       // transparent balance
    property bool   walletBusy: false
    property var    paySessions: []         // active prepaid sessions to providers
    property var    payStartTick: ({})      // provider → tick when its proof started
    property int    payTick: 0              // ~1s counter for the elapsed display

    // ── Logos bridge helpers ─────────────────────────────────────────

    function callInf(method, args) {
        if (typeof logos === "undefined" || !logos.callModule) {
            console.log("logos bridge unavailable")
            return null
        }
        return logos.callModule("inference", method, args)
    }

    // Paid providers are settled through the shared logos_wallet module, so we
    // query it straight from here to show the balance the payment spends from
    // (and to open it — otherwise a paid prompt silently can't pay).
    function callWallet(method, args) {
        if (typeof logos === "undefined" || !logos.callModule) return null
        return logos.callModule("logos_wallet", method, args)
    }
    function walletParse(raw) {
        var v = raw
        for (var i = 0; i < 2 && typeof v === "string"; i++) { try { v = JSON.parse(v) } catch (e) { break } }
        return (v && typeof v === "object") ? v : null
    }
    property bool walletLoaded: false        // logos_wallet module is present/loaded
    function refreshWallet() {
        const st = walletParse(callWallet("lezStatus", []))
        walletLoaded = !!st
        if (!st) return   // module not loaded yet — bar prompts to open the wallet app
        walletHasWallet = !!st.hasWallet
        walletOpen      = !!st.ready
        walletBusy      = !!st.busy
        // Auto-open a persisted wallet so paying just works (no separate app trip).
        if (walletHasWallet && !walletOpen && !walletBusy) { callWallet("lezOpen", []); return }
        if (!walletOpen) return
        // Balance we can actually pay with = the TOTAL across every private
        // account, not just the primary (the deshield auto-picks whichever
        // account holds funds, so the primary being empty is irrelevant).
        const acc = walletParse(callWallet("lezAccounts", []))
        if (acc && acc.ok && Array.isArray(acc.accounts)) {
            var priv = 0, pub = 0
            for (var i = 0; i < acc.accounts.length; i++) {
                var b = Number(acc.accounts[i].balance) || 0
                if (acc.accounts[i].isPublic) pub += b; else priv += b
            }
            walletPrivBal = String(priv)
            walletPubBal  = String(pub)
        }
    }

    // Basecamp JSON-encodes every remote-method return, so a C++ QString arrives
    // in QML as a JSON-string literal. Unwrap that layer before using.
    function unwrapRemote(raw, defaultVal) {
        if (raw === null || raw === undefined) return defaultVal
        if (typeof raw !== "string") return raw
        try { return JSON.parse(raw) } catch (e) { return defaultVal }
    }

    function refresh() {
        const sNum = unwrapRemote(callInf("deliveryStatus", []), 0)
        deliveryStatus = (typeof sNum === "number") ? sNum : 0
        if (myId === "") {
            const v = unwrapRemote(callInf("myId", []), "")
            myId = (typeof v === "string") ? v : ""
        }
        const r = unwrapRemote(callInf("room", []), "agora")
        if (typeof r === "string" && r.length > 0) currentRoom = r
        const inner = unwrapRemote(callInf("listExchanges", []), [])
        try {
            exchanges = (typeof inner === "string") ? JSON.parse(inner) : inner
        } catch (e) { exchanges = [] }
        refreshIdentity()
        const provRaw = unwrapRemote(callInf("listProviders", []), [])
        try {
            providers = (typeof provRaw === "string") ? JSON.parse(provRaw) : provRaw
        } catch (e) { providers = [] }
        const psRaw = unwrapRemote(callInf("paymentStatus", []), [])   // cheap in-memory call
        try {
            paySessions = (typeof psRaw === "string") ? JSON.parse(psRaw) : psRaw
        } catch (e) { paySessions = [] }
        // Track when each in-flight (not-yet-funded) payment's proof started, so
        // we can show a live elapsed time while the zk proof generates.
        var seen = {}
        for (var i = 0; i < paySessions.length; i++) {
            var f = paySessions[i].provider; seen[f] = true
            if (!paySessions[i].ready && payStartTick[f] === undefined) payStartTick[f] = payTick
            if (paySessions[i].ready) delete payStartTick[f]
        }
        for (var k in payStartTick) if (!seen[k]) delete payStartTick[k]
        // Wallet queries are synchronous and heavy (lezAccounts walks every
        // account), so throttle them — every ~6s once open — to keep the 1s
        // refresh loop from blocking the UI thread.
        if (_walletTick++ % 6 === 0) refreshWallet()
    }
    property int _walletTick: 0

    function liveProviders() {
        var n = 0
        for (var i = 0; i < providers.length; i++)
            if (providers[i].live) n++
        return n
    }

    function refreshIdentity() {
        const raw = unwrapRemote(callInf("identityStatus", []), "")
        try {
            const st = (typeof raw === "string") ? JSON.parse(raw) : raw
            identityInit      = !!st.initialized
            identityLocked    = !!st.locked
            identityFp        = st.fingerprint || ""
            identityBackend   = st.backend || ""
            requireEncryption = !!st.requireEncryption
            preferredProvider = st.preferredProvider || ""
            modelFilter       = st.modelFilter || ""
            trustedOnly       = !!st.trustedOnly
            trustedCount      = st.trustedCount || 0
        } catch (e) { /* keep previous state */ }
    }

    function providerModels(p) {
        return (p.models && p.models.length > 0) ? p.models.join(", ") : (p.model || "?")
    }

    // Human price label: "free" or e.g. "0.5 / req". Assetless amounts are LEZ
    // units until LEZ names them.
    function priceLabel(p) {
        // Incentivized (LEZ payment stream): billed by rate over time, not a
        // per-request amount — so priceAmount is 0 but it is NOT free.
        if (p.access === "lez") return "⚡ " + (p.rate || 0) + "/s"
        if (!p.priceAmount || p.priceAmount <= 0) return "free"
        var unit = p.priceUnit === "1ktokens" ? "1k tok" : "req"
        return p.priceAmount + " / " + unit
    }
    function isPaid(p) { return p.access === "lez" || (p.priceAmount > 0) }

    function providerLabel(fp) {
        for (var i = 0; i < providers.length; i++)
            if (providers[i].id === fp)
                return (providers[i].origin === "discovery" ? "🌐 " : "🚪 ")
                       + fp.substring(0, 10) + "… (" + providerModels(providers[i]) + ")"
        return fp.substring(0, 10) + "…"
    }

    // Every distinct model advertised by a live provider — feeds the model picker.
    function distinctModels() {
        var out = []
        for (var i = 0; i < providers.length; i++) {
            if (!providers[i].live) continue
            var ms = (providers[i].models && providers[i].models.length > 0)
                     ? providers[i].models : [providers[i].model]
            for (var j = 0; j < ms.length; j++)
                if (ms[j] && out.indexOf(ms[j]) === -1) out.push(ms[j])
        }
        out.sort()
        return out
    }

    function providerServes(p, m) {
        if (!m || m.length === 0) return true
        var ms = (p.models && p.models.length > 0) ? p.models : [p.model]
        return ms.indexOf(m) !== -1
    }

    function findProvider(fp) {
        for (var i = 0; i < providers.length; i++)
            if (providers[i].id === fp) return providers[i]
        return null
    }

    // Providers a prompt could go to right now (live, serving the model
    // filter, and — when Trusted only is on — whitelisted).
    function eligibleProviders() {
        var n = 0
        for (var i = 0; i < providers.length; i++)
            if (providers[i].live && providerServes(providers[i], modelFilter)
                && (!trustedOnly || providers[i].trusted)) n++
        return n
    }

    // One plain sentence: where will my next prompt go?
    function routingSummary() {
        if (preferredProvider.length > 0) {
            var p = findProvider(preferredProvider)
            return "Prompts go to 📌 " + preferredProvider.substring(0, 10) + "…"
                   + (modelFilter ? " running " + modelFilter : (p ? " (" + (p.model || "?") + ")" : ""))
        }
        var n = eligibleProviders()
        if (n === 0) {
            if (trustedOnly && trustedCount === 0)
                return "⚠ Trusted only is on but nothing is trusted — click 🛡 on a provider"
            return modelFilter
                ? "⚠ no live provider serves " + modelFilter + " — prompts will wait/fail"
                : "⚠ no live providers yet — listening for capability cards…"
        }
        return "Auto: best of " + n + " available provider(s)"
               + (modelFilter ? " serving " + modelFilter : "")
    }

    function unlockIdentity() {
        const ok = unwrapRemote(callInf("unlock", [unlockField.text]), false)
        if (ok === true) unlockField.text = ""
        refreshIdentity()
    }

    function createIdentity() {
        const m = unwrapRemote(callInf("createAccount", [""]), "")
        refreshIdentity()
        if (typeof m === "string" && m.length > 0) {
            freshMnemonic = m
            mnemonicPopup.open()
        }
    }

    function importIdentity() {
        const phrase = importField.text.trim()
        if (phrase.length === 0) return
        const ok = unwrapRemote(callInf("importAccount", [phrase, ""]), false)
        if (ok === true) importField.text = ""
        refreshIdentity()
    }

    function send() {
        const p = promptField.text.trim()
        if (p.length === 0 || deliveryStatus === 0) return
        callInf("sendPrompt", [p])
        promptField.text = ""
        refresh()
    }

    function statusText(s) {
        if (s === 0) return "Off"
        if (s === 1) return "Connecting…"
        if (s === 2) return "Connected"
        if (s === 3) return "Error"
        return ""
    }
    function statusColor(s) {
        if (s === 2) return "#34a853"
        if (s === 1) return "#fbbc04"
        if (s === 3) return "#ea4335"
        return "#9aa5b1"
    }
    function topicFor(room) { return "/inference/1/" + room + "/json" }

    // ── Layout ───────────────────────────────────────────────────────

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 20
        spacing: 12

        // Header
        RowLayout {
            Layout.fillWidth: true
            spacing: 10
            Text {
                text: "AI Inference"
                font.pixelSize: 24
                font.weight: Font.DemiBold
                Layout.fillWidth: true
            }
            Rectangle { width: 10; height: 10; radius: 5; color: statusColor(deliveryStatus) }
            Text { text: statusText(deliveryStatus); color: "#444"; font.pixelSize: 13 }
            Button {
                text: deliveryStatus === 0 ? "Start" : "Stop"
                onClicked: {
                    if (deliveryStatus === 0) callInf("startDelivery", [])
                    else                      callInf("stopDelivery",  [])
                    refresh()
                }
            }
        }

        // ── LEZ wallet bar — the balance paid providers are settled from ──
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 40
            radius: 8
            color: walletOpen ? "#f0f7f0" : "#fff6e6"
            border.color: walletOpen ? "#cfe6cf" : "#f0d58c"; border.width: 1
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 12; anchors.rightMargin: 12
                spacing: 12
                Text { text: "👛 Wallet"; font.pixelSize: 13; font.weight: Font.DemiBold; color: "#333" }
                Rectangle { width: 8; height: 8; radius: 4
                    color: walletOpen ? "#188038" : (walletBusy ? "#b26a00" : "#c0392b") }
                Text {
                    visible: walletOpen
                    text: "🔒 " + walletPrivBal + " private   ·   🌐 " + walletPubBal + " public"
                    color: "#234a86"; font.pixelSize: 13
                }
                Text {
                    visible: !walletOpen
                    text: !walletLoaded ? "open the Logos Wallet app once to enable payments"
                          : walletBusy ? "opening…"
                          : walletHasWallet ? "closed — open it to pay paid providers"
                          : "no wallet — open the Logos Wallet app to create one"
                    color: "#7a5c00"; font.pixelSize: 12
                }
                Item { Layout.fillWidth: true }
                Text {
                    text: "prompts paid via logos_wallet (shielded)"
                    color: "#9aa5b1"; font.pixelSize: 10
                }
                Button {
                    visible: !walletOpen && walletHasWallet
                    text: walletBusy ? "…" : "Open wallet"
                    enabled: !walletBusy
                    onClicked: { callWallet("lezOpen", []); walletBusy = true }
                }
            }
        }

        // ── Live payment/session status — makes the paid flow legible ──
        Repeater {
            model: root.paySessions
            delegate: Text {
                Layout.fillWidth: true; wrapMode: Text.Wrap; font.pixelSize: 12
                color: modelData.ready ? "#188038" : "#b26a00"
                text: {
                    var fp = String(modelData.provider).substring(0, 10) + "…"
                    if (!modelData.ready) {
                        var st = root.payStartTick[modelData.provider]
                        var el = (st !== undefined) ? Math.max(0, root.payTick - st) : 0
                        var mm = Math.floor(el / 60), ss = el % 60
                        var clk = mm + ":" + (ss < 10 ? "0" : "") + ss
                        return "🔐 generating zk proof — paying " + fp + " · " + modelData.amount
                               + " LEZ · " + clk + " elapsed (~1 min)"
                               + (modelData.waiting > 0 ? "  ·  " + modelData.waiting + " prompt(s) queued" : "")
                    }
                    var left = Math.max(0, (modelData.quota || 0) - (modelData.used || 0))
                    return "💳 " + fp + " · session active · " + left + "/" + (modelData.quota || 0)
                           + " prompts left · paid " + modelData.amount + " LEZ"
                }
            }
        }

        Text {
            visible: myId.length > 0
            text: "my id: " + myId + "   ·   topic: " + topicFor(currentRoom)
            color: "#888"
            font.pixelSize: 11
        }

        // Identity chip (once an account exists)
        Text {
            visible: identityInit
            text: "identity: " + identityFp.substring(0, 16) + "…   ·   " + identityBackend
                  + (deliveryStatus === 2
                     ? (liveProviders() > 0
                        ? "   ·   🔒 " + liveProviders() + " provider(s) — prompts encrypted"
                        : "   ·   ⚠ no providers heard — prompts go plaintext")
                     : "")
            color: "#666"
            font.pixelSize: 11

            MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: { clipProxy.text = identityFp; clipProxy.selectAll(); clipProxy.copy() }
            }
        }
        // Invisible helper so clicking the chip copies the full fingerprint.
        TextEdit { id: clipProxy; visible: false }

        // Unlock card (passphrase-protected key file on disk)
        Rectangle {
            visible: identityLocked
            Layout.fillWidth: true
            Layout.preferredHeight: 76
            color: "#eef4ff"
            border.color: "#a9c7f0"; border.width: 1; radius: 8

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 12
                spacing: 8
                Text {
                    text: "🔐 Identity locked"
                    font.pixelSize: 14; font.weight: Font.DemiBold; color: "#234a86"
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    TextField {
                        id: unlockField
                        Layout.fillWidth: true
                        echoMode: TextInput.Password
                        placeholderText: "passphrase"
                        font.pixelSize: 12
                        onAccepted: unlockIdentity()
                    }
                    Button {
                        text: "Unlock"
                        enabled: unlockField.text.length > 0
                        onClicked: unlockIdentity()
                    }
                }
            }
        }

        // Identity setup card (first run — hidden once an identity exists or is locked)
        Rectangle {
            visible: !identityInit && !identityLocked
            Layout.fillWidth: true
            Layout.preferredHeight: idCol.implicitHeight + 24
            color: "#fff8e6"
            border.color: "#f0d58c"; border.width: 1; radius: 8

            ColumnLayout {
                id: idCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 12
                spacing: 8

                Text {
                    text: "No identity yet"
                    font.pixelSize: 14
                    font.weight: Font.DemiBold
                    color: "#7a5c00"
                }
                Text {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    font.pixelSize: 12
                    color: "#7a5c00"
                    text: "One account backs everything — signing keys, encryption keys, "
                        + "and (soon) rate-limit membership. Create one, or import an "
                        + "existing seed phrase."
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Button { text: "Create new account"; onClicked: createIdentity() }
                    TextField {
                        id: importField
                        Layout.fillWidth: true
                        placeholderText: "…or paste a seed phrase to import"
                        font.pixelSize: 12
                        onAccepted: importIdentity()
                    }
                    Button {
                        text: "Import"
                        enabled: importField.text.trim().length > 0
                        onClicked: importIdentity()
                    }
                }
            }
        }

        // Room row
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 52
            color: "#f8f9fa"
            border.color: "#dfe3e8"; border.width: 1; radius: 8
            RowLayout {
                anchors.fill: parent
                anchors.margins: 10
                spacing: 8
                Text { text: "Marketplace"; color: "#555"; font.pixelSize: 13 }
                // No binding to currentRoom — that would clobber typing on every poll.
                TextField {
                    id: roomField
                    Layout.fillWidth: true
                    placeholderText: currentRoom
                }
                Button {
                    text: "Join"
                    enabled: roomField.text.trim().length > 0
                             && roomField.text.trim() !== currentRoom
                    onClicked: { callInf("joinRoom", [roomField.text.trim()]); refresh() }
                }
            }
        }

        // Routing controls: pick a model (from what the marketplace actually
        // offers), pick a provider (only ones serving that model), and see in
        // one sentence where the next prompt will go.
        Rectangle {
            visible: identityInit
            Layout.fillWidth: true
            Layout.preferredHeight: 78
            color: "#f8f9fa"
            border.color: "#dfe3e8"; border.width: 1; radius: 8
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 10
                spacing: 6
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Text { text: "Model"; color: "#555"; font.pixelSize: 13 }
                    ComboBox {
                        id: modelBox
                        Layout.preferredWidth: 170
                        font.pixelSize: 12
                        // Union of every model advertised by live providers —
                        // no typing, no guessing names.
                        model: {
                            var m = [{ text: "Any model", val: "" }]
                            var ds = distinctModels()
                            for (var i = 0; i < ds.length; i++)
                                m.push({ text: ds[i], val: ds[i] })
                            return m
                        }
                        textRole: "text"
                        currentIndex: {
                            for (var i = 0; i < model.length; i++)
                                if (model[i].val === modelFilter) return i
                            return 0
                        }
                        onActivated: {
                            var v = model[currentIndex].val || ""
                            callInf("setModelFilter", [v])
                            // A pinned provider that can't serve the new model
                            // would silently never be picked — unpin instead.
                            var p = findProvider(preferredProvider)
                            if (p && !providerServes(p, v))
                                callInf("setPreferredProvider", [""])
                            refreshIdentity()
                        }
                    }
                    Text { text: "Provider"; color: "#555"; font.pixelSize: 13 }
                    ComboBox {
                        id: providerBox
                        Layout.fillWidth: true
                        font.pixelSize: 12
                        // Auto + only live providers that serve the chosen model.
                        model: {
                            var m = [{ text: "Auto — pick for me", fp: "" }]
                            for (var i = 0; i < providers.length; i++)
                                if (providers[i].live
                                    && providerServes(providers[i], modelFilter))
                                    m.push({ text: providerLabel(providers[i].id),
                                             fp: providers[i].id })
                            return m
                        }
                        textRole: "text"
                        // Bind the shown selection to the backend's actual choice, so
                        // the 1s poll (which rebuilds `model`) can't reset it to Auto.
                        currentIndex: {
                            for (var i = 0; i < model.length; i++)
                                if (model[i].fp === preferredProvider) return i
                            return 0   // preferred not live → show Auto
                        }
                        onActivated: {
                            callInf("setPreferredProvider", [model[currentIndex].fp || ""])
                            refreshIdentity()
                        }
                    }
                    CheckBox {
                        text: "Require 🔒"
                        checked: requireEncryption
                        font.pixelSize: 12
                        onToggled: {
                            callInf("setRequireEncryption", [checked])
                            refreshIdentity()
                        }
                    }
                    CheckBox {
                        text: "Trusted 🛡"
                        checked: trustedOnly
                        font.pixelSize: 12
                        onToggled: {
                            callInf("setTrustedOnly", [checked])
                            refreshIdentity()
                        }
                    }
                }
                Text {
                    Layout.fillWidth: true
                    text: routingSummary()
                    color: text.indexOf("⚠") === 0 ? "#b26a00" : "#188038"
                    font.pixelSize: 11
                    elide: Text.ElideRight
                }
            }
        }

        // Marketplace: every provider heard on the global discovery topic (🌐)
        // or in this room (🚪). Click a row to pin prompts to that provider;
        // click it again to go back to Auto. Rows that don't serve the chosen
        // model are dimmed and unclickable.
        Rectangle {
            visible: identityInit && providers.length > 0
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(34 + providers.length * 30, 140)
            color: "#f8f9fa"
            border.color: "#dfe3e8"; border.width: 1; radius: 8

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 10
                spacing: 4

                RowLayout {
                    Layout.fillWidth: true
                    Text {
                        text: "Marketplace — " + liveProviders() + " live provider(s)"
                        color: "#555"; font.pixelSize: 12; font.weight: Font.DemiBold
                        Layout.fillWidth: true
                    }
                    Text {
                        text: preferredProvider.length > 0
                              ? "click 📌 row to unpin" : "click a row to pin"
                        color: "#9aa5b1"; font.pixelSize: 10
                    }
                }
                ListView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    model: providers
                    delegate: Rectangle {
                        property bool pinned: modelData.id === preferredProvider
                        property bool eligible: modelData.live
                                                && providerServes(modelData, modelFilter)
                                                && (!trustedOnly || modelData.trusted)
                        width: ListView.view.width
                        height: 28
                        radius: 4
                        opacity: eligible ? 1.0 : 0.4
                        color: pinned ? "#e8f0fe"
                               : (pRow.containsMouse && eligible ? "#f1f3f4" : "transparent")
                        border.color: pinned ? "#a9c7f0" : "transparent"
                        border.width: pinned ? 1 : 0

                        RowLayout {
                            anchors.fill: parent
                            anchors.leftMargin: 6; anchors.rightMargin: 6
                            spacing: 8
                            Text {
                                text: (pinned ? "📌 " : "")
                                      + (modelData.origin === "discovery" ? "🌐" : "🚪")
                                      + (modelData.live ? "" : " 💤")
                                font.pixelSize: 12
                            }
                            Text {
                                text: modelData.id.substring(0, 12) + "…"
                                font.pixelSize: 12; font.family: "Menlo"
                                color: "#1f2d3d"
                            }
                            Text {
                                Layout.fillWidth: true
                                text: providerModels(modelData)
                                      + (!modelData.live ? "  (last heard "
                                         + Math.floor(modelData.ageMs / 1000) + "s ago)"
                                         : (!eligible ? "  (no " + modelFilter + ")" : ""))
                                font.pixelSize: 12; color: "#555"
                                elide: Text.ElideRight
                            }
                            // Integrity: did a canary audit confirm the advertised
                            // model? ✓ verified · ✗ FAILED (caught substituting a
                            // weaker model) · (nothing) if not yet audited.
                            Text {
                                visible: modelData.integrity === "verified"
                                         || modelData.integrity === "failed"
                                         || modelData.integrity === "mixed"
                                text: modelData.integrity === "verified" ? "✓"
                                      : modelData.integrity === "mixed" ? "⚠" : "✗ fake"
                                font.pixelSize: 11
                                color: modelData.integrity === "verified" ? "#188038"
                                       : modelData.integrity === "mixed" ? "#9a7700" : "#c5221f"
                                MouseArea {
                                    anchors.fill: parent; anchors.margins: -4
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: { callInf("auditProvider", [modelData.id]); refresh() }
                                }
                            }
                            // My own experience with this provider (answers vs
                            // timeouts) — shown once there is any history.
                            Text {
                                visible: (modelData.hits || 0) + (modelData.misses || 0) > 0
                                text: Math.round((modelData.score || 0.5) * 100) + "%"
                                font.pixelSize: 11
                                color: (modelData.score || 0.5) >= 0.75 ? "#188038"
                                       : (modelData.score || 0.5) >= 0.5 ? "#9a7700" : "#c5221f"
                            }
                            // Credential demand: ⛏ = anonymous prompts pay a
                            // small proof-of-work stamp (computed automatically).
                            Text {
                                visible: modelData.access === "pow"
                                text: "⛏"
                                font.pixelSize: 11; color: "#9a7700"
                            }
                            // Users only need to know if it can take a prompt NOW.
                            // Slot counts are operator telemetry — the auto-picker
                            // already weighs load internally.
                            Text {
                                visible: modelData.cap > 0 && modelData.load >= modelData.cap
                                text: "busy"
                                font.pixelSize: 11
                                color: "#c5221f"
                            }
                            Text {
                                text: priceLabel(modelData)
                                font.pixelSize: 11
                                color: isPaid(modelData) ? "#188038" : "#888"
                            }
                            // Whitelist toggle — independent of the pin click.
                            Text {
                                text: "🛡"
                                font.pixelSize: 12
                                opacity: modelData.trusted ? 1.0 : 0.25
                                MouseArea {
                                    anchors.fill: parent
                                    anchors.margins: -4
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: {
                                        callInf("setTrusted",
                                                [modelData.id, !modelData.trusted])
                                        refresh()
                                    }
                                }
                            }
                        }
                        MouseArea {
                            id: pRow
                            anchors.fill: parent
                            hoverEnabled: true
                            enabled: eligible
                            cursorShape: eligible ? Qt.PointingHandCursor : Qt.ArrowCursor
                            onClicked: {
                                // Toggle: pin this provider ⟷ back to Auto.
                                const fp = pinned ? "" : modelData.id
                                callInf("setPreferredProvider", [fp])
                                refreshIdentity()
                            }
                        }
                    }
                }
            }
        }

        // Prompt composer
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 110
            color: "#f8f9fa"
            border.color: "#dfe3e8"; border.width: 1; radius: 8
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 10
                spacing: 8
                ScrollView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    TextArea {
                        id: promptField
                        placeholderText: "Ask the model anything…  (Ctrl+Enter to send)"
                        wrapMode: TextArea.Wrap
                        font.pixelSize: 13
                        selectByMouse: true
                        Keys.onPressed: (e) => {
                            if ((e.modifiers & Qt.ControlModifier) &&
                                (e.key === Qt.Key_Return || e.key === Qt.Key_Enter)) {
                                send(); e.accepted = true
                            }
                        }
                    }
                }
                Button {
                    Layout.alignment: Qt.AlignRight
                    text: "Send prompt"
                    enabled: deliveryStatus !== 0 && promptField.text.trim().length > 0
                    onClicked: send()
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Text {
                text: exchanges.length > 0 ? exchanges.length + " prompt(s)" : ""
                color: "#666"; font.pixelSize: 12; Layout.fillWidth: true
            }
            Button {
                text: "Clear"
                visible: exchanges.length > 0
                onClicked: { callInf("clearExchanges", []); refresh() }
            }
        }

        // Exchange list (newest first)
        ListView {
            id: listView
            Layout.fillWidth: true
            Layout.fillHeight: true
            model: exchanges
            spacing: 10
            clip: true

            delegate: Rectangle {
                width: listView.width
                height: col.implicitHeight + 22
                color: "white"
                border.color: modelData.failed ? "#ea4335"
                              : modelData.answered ? "#34a853" : "#dfe3e8"
                border.width: 1
                radius: 8

                ColumnLayout {
                    id: col
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: 12
                    spacing: 6

                    // The prompt (what you asked)
                    Text {
                        text: "🧑  " + modelData.prompt
                        font.pixelSize: 13
                        font.weight: Font.DemiBold
                        color: "#1f2d3d"
                        wrapMode: Text.WordWrap
                        Layout.fillWidth: true
                    }

                    Rectangle { Layout.fillWidth: true; height: 1; color: "#eef1f4" }

                    // The response (thinking / answer / failed)
                    Text {
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                        textFormat: Text.PlainText
                        font.pixelSize: 13
                        color: modelData.failed ? "#c5221f"
                               : modelData.answered ? "#1f2d3d"
                               : modelData.paying ? "#b26a00" : "#9a7700"
                        text: modelData.failed
                              ? "⚠  no provider answered — try again or pick another provider"
                              : modelData.answered
                                ? ("🤖  " + (modelData.text && modelData.text.length > 0
                                            ? modelData.text : "(empty response)"))
                                : modelData.paying
                                  // Parked while the payment's zk proof settles — say so,
                                  // don't pretend the model is "thinking".
                                  ? ("🔐  generating zk proof for payment… "
                                     + Math.floor(modelData.ageMs / 1000) + "s (~1 min)")
                                  : ("🤖  thinking… " + Math.floor(modelData.ageMs / 1000) + "s"
                                     + (modelData.retries > 0
                                        ? "  (retry " + modelData.retries + ")" : ""))
                    }

                    // Footer: sealed · model · provider · latency
                    Text {
                        visible: modelData.answered
                        text: (modelData.sealed ? "🔒 E2E  ·  " : "")
                              + (modelData.model || "model")
                              + "  ·  " + (modelData.provider || "?")
                              + "  ·  " + modelData.rttMs + " ms"
                        color: "#188038"
                        font.pixelSize: 11
                    }
                }
            }

            Label {
                anchors.centerIn: parent
                visible: exchanges.length === 0
                width: parent.width - 40
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
                text: deliveryStatus === 0
                      ? "Press Start, type a prompt, and Send.\nA logoscore-CLI provider running ollama will answer."
                      : "Type a prompt and Send — it goes onto\n" + topicFor(currentRoom)
                color: "#9aa5b1"
            }
        }
    }

    // Seed-phrase reveal — the mnemonic exists only here, once. Closing it is
    // the user's confirmation that it's written down.
    Popup {
        id: mnemonicPopup
        anchors.centerIn: parent
        width: Math.min(parent.width - 60, 520)
        modal: true
        closePolicy: Popup.NoAutoClose
        onClosed: freshMnemonic = ""

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 8
            spacing: 10

            Text {
                text: "Your seed phrase — write it down now"
                font.pixelSize: 15
                font.weight: Font.DemiBold
            }
            Text {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                font.pixelSize: 12
                color: "#a33"
                text: "This is the ONLY backup of your identity and it will not be "
                    + "shown again. Anyone who has it can become you."
            }
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: mnemonicText.implicitHeight + 20
                color: "#f4f6f8"; radius: 6
                border.color: "#dfe3e8"; border.width: 1
                TextEdit {
                    id: mnemonicText
                    anchors.fill: parent
                    anchors.margins: 10
                    text: freshMnemonic
                    readOnly: true
                    selectByMouse: true
                    wrapMode: TextEdit.Wrap
                    font.pixelSize: 14
                    font.family: "Menlo"
                }
            }
            Button {
                Layout.alignment: Qt.AlignRight
                text: "I've written it down"
                onClicked: mnemonicPopup.close()
            }
        }
    }

    // Poll for live updates. A production app would subscribe to inference's
    // responseReceived / promptSent events via logos.onModuleEvent(...).
    Timer {
        interval: 1000
        running: true
        repeat: true
        onTriggered: { root.payTick++; refresh() }
    }

    Component.onCompleted: refresh()
}
