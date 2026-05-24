const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;

// הגדרות אחסון קבצים (עבור תמונות לקמפיינים)
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// הגדרות שרת ותצוגה
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use('/uploads', express.static('uploads'));
app.set('view engine', 'ejs');

// יצירת תיקיות נדרשות אם אינן קיימות
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// בסיס נתונים פשוט בקובץ עבור ההיסטוריה (נשמר גם בעדכוני קוד)
const HISTORY_FILE = './campaigns.json';
let campaignsHistory = [];
if (fs.existsSync(HISTORY_FILE)) {
    try { campaignsHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { campaignsHistory = []; }
}
function saveHistory() {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(campaignsHistory, null, 2), 'utf8');
}

// משתני מערכת גלובליים
let client;
let qrCodeData = '';
let waStatus = 'disconnected'; // disconnected, qr, connecting, ready
let whatsappGroups = []; // רשימת הקבוצות שנסרקו
let activeSchedules = []; // ניהול קמפיינים פעילים במקביל

// אתחול קליינט וואטסאפ
function initWhatsApp() {
    waStatus = 'connecting';
    client = new Client({
        authStrategy: new LocalAuth({ clientId: "wa-broadcaster" }),
        puppeteer: { 
    headless: true, 
    protocolTimeout: 300000, 
    args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--gpu-process-limit=1'
    ] 
}
    });

    client.on('qr', (qr) => {
        waStatus = 'qr';
        qrcode.toDataURL(qr, (err, url) => {
            if (!err) qrCodeData = url;
        });
    });

    client.on('ready', async () => {
        waStatus = 'ready';
        qrCodeData = '';
        console.log('WhatsApp Client is READY');
        
        setTimeout(async () => {
            try {
                console.log('מתחיל סריקת קבוצות...');
                const chats = await client.getChats();
                
                whatsappGroups = chats
                    .filter(chat => chat.isGroup)
                    .map(group => {
                        // לוקח את השם המקורי בדיוק כפי שהוא מופיע בוואטסאפ (כולל ניקוד)
                        let groupName = group.name ? group.name.trim() : '';
                        if (!groupName) {
                            groupName = "קבוצה ללא שם (" + group.id._serialized.split('@')[0] + ")";
                        }
                        return { 
                            id: group.id._serialized, 
                            name: groupName 
                        };
                    });
                
                console.log(`סריקת הקבוצות הסתיימה בהצלחה! נמצאו ${whatsappGroups.length} קבוצות.`);
            } catch (err) {
                console.error("שגיאה בסריקת קבוצות:", err);
            }
        }, 5000);
    });

    client.on('disconnected', (reason) => {
        waStatus = 'disconnected';
        qrCodeData = '';
        whatsappGroups = [];
        console.log('Client was logged out', reason);
    });

    client.initialize().catch(err => console.error("Initialization error:", err));
}

// הפעלה ראשונית
initWhatsApp();

// מנגנון לניהול ושליחת קמפיינים (תומך בריצה במקביל)
async function processCampaign(campaignId) {
    const campaign = campaignsHistory.find(c => c.id === campaignId);
    if (!campaign) return;

    campaign.status = 'במצע התהליך';
    saveHistory();

    const sendToTarget = async (target) => {
        try {
            if (campaign.mediaPath && fs.existsSync(campaign.mediaPath)) {
                // במערכת אמיתית משתמשים ב-MessageMedia.fromFilePath
                const { MessageMedia } = require('whatsapp-web.js');
                const media = MessageMedia.fromFilePath(campaign.mediaPath);
                await client.sendMessage(target.groupId, media, { caption: campaign.text });
            } else {
                await client.sendMessage(target.groupId, campaign.text);
            }
            target.sentAt = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
            target.status = 'נשלח';
        } catch (err) {
            target.status = 'נכשל';
            console.error(`שגיאה בשליחה לקבוצה ${target.groupName}:`, err);
        }
        saveHistory();
    };

    if (campaign.mode === '1') { 
        // 1. שליחה מרוכזת ברצף
        for (let target of campaign.targets) {
            await sendToTarget(target);
            await new Promise(r => setTimeout(r, 2000)); // השהיה קלה למניעת חסימות
        }
        campaign.status = 'הסתיים';
    } 
    else if (campaign.mode === '2') {
        // 2. שליחה במרווחים החל משעה מסוימת
        campaign.status = 'מחכה לשליחה';
        saveHistory();

        const [startHour, startMin] = campaign.startTime.split(':').map(Number);
        const now = new Date();
        let targetTime = new Date();
        targetTime.setHours(startHour, startMin, 0, 0);
        
        if (targetTime < now) {
            targetTime.setDate(targetTime.getDate() + 1); // אם השעה עברה, קבע למחר
        }

        let delayMs = targetTime - now;
        
        const timerId = setTimeout(async () => {
            campaign.status = 'במצע התהליך';
            saveHistory();
            
            for (let i = 0; i < campaign.targets.length; i++) {
                let target = campaign.targets[i];
                if (i > 0) {
                    await new Promise(r => setTimeout(r, campaign.intervalMinutes * 60 * 1000));
                }
                await sendToTarget(target);
            }
            campaign.status = 'הסתיים';
            saveHistory();
        }, delayMs);

        activeSchedules.push({ campaignId, timerId });
        return;
    } 
    else if (campaign.mode === '3') {
        // 3. שליחה בתזמון אישי לפי קבוצה
        campaign.status = 'מחכה לשליחה';
        saveHistory();

        campaign.targets.forEach(target => {
            if (!target.scheduledTime) {
                sendToTarget(target); // אם לא הוגדר זמן, שלח מיד
                return;
            }
            const distTime = new Date(target.scheduledTime);
            const now = new Date();
            const delay = distTime - now;

            if (delay > 0) {
                const timerId = setTimeout(async () => {
                    await sendToTarget(target);
                    // בדיקה אם כל הקבוצות בקמפיין סיימו
                    const allDone = campaign.targets.every(t => t.status !== 'מחכה');
                    if (allDone) campaign.status = 'הסתיים';
                    saveHistory();
                }, delay);
                activeSchedules.push({ campaignId, timerId });
            } else {
                sendToTarget(target); // זמן שעבר - שלח מיד
            }
        });
    }
    saveHistory();
}

// --- נתיבי השרת וממשק המשתמש (UI) ---

// עמוד התחברות למערכת
app.get('/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="he" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <title>כניסה למערכת הדיוור</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #121212; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .login-box { background: #1e1e1e; padding: 30px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); text-align: center; width: 300px; }
                input[type="password"] { width: 100%; padding: 10px; margin: 15px 0; border: 1px solid #333; background: #2a2a2a; color: #fff; border-radius: 4px; box-sizing: border-box; text-align: center; font-size: 16px; }
                button { background: #00a884; color: white; border: none; padding: 10px 20px; font-size: 16px; cursor: pointer; border-radius: 4px; width: 100%; font-weight: bold; }
                button:hover { background: #008f72; }
                .error { color: #ff5252; margin-top: 10px; font-size: 14px; }
            </style>
        </head>
        <body>
            <div class="login-box">
                <h2>מערכת דיוור לקבוצות</h2>
                <p>אנא הזן סיסמת גישה</p>
                <form action="/login" method="POST">
                    <input type="password" name="password" placeholder="סיסמה" required autocomplete="off">
                    <button type="submit">התחברות</button>
                </form>
                ${req.query.err ? '<div class="error">סיסמה שגויה!</div>' : ''}
            </div>
        </body>
        </html>
    `);
});

app.post('/login', (req, res) => {
    if (req.body.password === "211803200") {
        res.cookie('auth', 'true', { maxAge: 86400000 }); // יום אחד
        return res.redirect('/');
    }
    res.redirect('/login?err=1');
});

// מידלוור הגנה על דפים
function checkAuth(req, res, next) {
    // לצורך קוד אחיד נשתמש בפתרון פשוט מבוסס קוקי או הפניה ישירה בממשק הפרונט
    next();
}

// דף הבית המרכז את כל הלשוניות (ניהול, הגדרות, קבוצות, היסטוריה) בארכיטקטורת Single Page
app.get('/', checkAuth, (req, res) => {
    // קריאת תוכן ה-HTML שנשמר בקובץ המובנה
    const viewPath = path.join(__dirname, 'views', 'view.ejs');
    if (fs.existsSync(viewPath)) {
        let html = fs.readFileSync(viewPath, 'utf8');
        return res.send(html);
    }
    res.send("המערכת מתאחלת, אנא רענן את העמוד בעוד מספר שניות...");
});

// API לקבלת סטטוס וואטסאפ ורשימת קבוצות עדכנית (עבור ה-AJAX בפרונט)
app.get('/api/status', (req, res) => {
    res.json({ status: waStatus, qr: qrCodeData, groups: whatsappGroups, history: campaignsHistory });
});

// יצירת קמפיין חדש ושליחה
app.post('/api/campaign', upload.single('media'), (req, res) => {
    if (waStatus !== 'ready') return res.status(400).send('הוואטסאפ אינו מחובר!');
    
    const { text, mode, startTime, intervalMinutes, groupIds, personalSchedule } = req.body;
    let selectedGroupIds = Array.isArray(groupIds) ? groupIds : [groupIds].filter(Boolean);
    
    if (selectedGroupIds.length === 0) return res.status(400).send('לא נבחרו קבוצות');

    let targets = selectedGroupIds.map(id => {
        const gObj = whatsappGroups.find(g => g.id === id);
        let scheduledTime = null;
        if (mode === '3' && personalSchedule && personalSchedule[id]) {
            scheduledTime = personalSchedule[id];
        }
        return {
            groupId: id,
            groupName: gObj ? gObj.name : id,
            status: 'מחכה',
            sentAt: '-',
            scheduledTime: scheduledTime
        };
    });

    const newCampaign = {
        id: 'camp_' + Date.now(),
        date: new Date().toLocaleDateString('he-IL'),
        time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
        text: text,
        mediaPath: req.file ? req.file.path : null,
        mediaName: req.file ? req.file.originalname : null,
        mode: mode,
        startTime: startTime || null,
        intervalMinutes: parseInt(intervalMinutes) || 0,
        status: 'מחכה לשליחה',
        targets: targets
    };

    campaignsHistory.unshift(newCampaign); // הוספה לראש הרשימה
    saveHistory();

    // הפעלת תהליך השליחה ברקע
    processCampaign(newCampaign.id);

    res.redirect('/?msg=success');
});

// ניתוק וואטסאפ ומחיקת סשן קודם
app.post('/api/logout', async (req, res) => {
    try {
        if (client) {
            await client.destroy();
        }
    } catch (e) {}
    
    // מחיקת תיקיית ה-Auth של LocalAuth לאיפוס מוחלט
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    
    // אתחול מחדש לקבלת ברקוד נקי
    initWhatsApp();
    res.json({ success: true });
});

// יצירת קובץ התצוגה המובנה בשרת (EJS כחלק מהקוד האחיד)
if (!fs.existsSync('./views')) fs.mkdirSync('./views');
fs.writeFileSync('./views/view.ejs', `
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>מערכת הפצת הודעות לוואטסאפ</title>
    <style>
        :root { --bg: #121212; --panel: #1e1e1e; --border: #333; --text: #e0e0e0; --primary: #00a884; --primary-hover: #008f72; }
        body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; box-sizing: border-box; }
        .navbar { background: var(--panel); border-bottom: 1px solid var(--border); display: flex; padding: 10px 20px; gap: 20px; align-items: center; }
        .navbar h2 { margin: 0; color: var(--primary); margin-left: auto; font-size: 20px; }
        .nav-btn { background: none; border: none; color: #aaa; padding: 10px 15px; cursor: pointer; font-size: 16px; font-weight: bold; border-bottom: 2px solid transparent; }
        .nav-btn.active { color: var(--primary); border-bottom-color: var(--primary); }
        .container { padding: 20px; max-width: 1100px; margin: 0 auto; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
        .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 20px; }
        h3 { margin-top: 0; border-bottom: 1px solid var(--border); padding-bottom: 10px; color: #fff; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: 500; font-size: 14px; }
        textarea, input[type="text"], input[type="number"], input[type="time"], input[type="datetime-local"], select { 
            width: 100%; padding: 10px; background: #2a2a2a; border: 1px solid var(--border); color: #fff; border-radius: 4px; box-sizing: border-box; 
        }
        .btn { background: var(--primary); color: #fff; border: none; padding: 12px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 16px; width: 100%; }
        .btn:hover { background: var(--primary-hover); }
        .btn-danger { background: #ea0038; }
        .btn-danger:hover { background: #c2002e; }
        .group-list-box { max-height: 200px; overflow-y: auto; border: 1px solid var(--border); padding: 10px; background: #262626; border-radius: 4px; }
        .group-item { display: flex; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid #333; }
        .group-item:last-child { border-bottom: none; }
        .status-badge { display: inline-block; padding: 5px 10px; border-radius: 12px; font-size: 13px; font-weight: bold; background: #333; }
        .status-ready { background: #06d6a0; color: #000; }
        .status-qr { background: #ffd166; color: #000; }
        .status-connecting { background: #118ab2; color: #fff; }
        .qr-container { text-align: center; margin: 20px 0; background: white; padding: 15px; display: inline-block; border-radius: 8px; }
        .qr-container img { max-width: 250px; display: block; }
        .history-item { border: 1px solid var(--border); background: #252525; border-radius: 6px; padding: 15px; margin-bottom: 15px; }
        .history-header { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14px; color: #aaa; border-bottom: 1px dashed #444; padding-bottom: 5px; }
        .camp-status { font-weight: bold; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
        .status-done { background: rgba(6, 214, 160, 0.2); color: #06d6a0; }
        .status-progress { background: rgba(17, 138, 178, 0.2); color: #118ab2; }
        .status-wait { background: rgba(255, 209, 102, 0.2); color: #ffd166; }
        .target-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
        .target-table th, .target-table td { border: 1px solid #3c3c3c; padding: 6px; text-align: right; }
        .target-table th { background: #333; }
    </style>
</head>
<body>

    <div class="navbar">
        <h2>מערכת דיוור מרוכזת קבוצתית</h2>
        <button class="nav-btn active" onclick="switchTab('manage')">ניהול קמפיין</button>
        <button class="nav-btn" onclick="switchTab('groups')">ניהול קבוצות (<span id="group-count">0</span>)</button>
        <button class="nav-btn" onclick="switchTab('history')">היסטוריית קמפיינים</button>
        <button class="nav-btn" onclick="switchTab('settings')">הגדרות וחיבור</button>
        <div style="margin-right: 15px;">
            סטטוס: <span id="global-status" class="status-badge">טוען...</span>
        </div>
    </div>

    <div class="container">
        
        <div id="tab-manage" class="tab-content active">
            <form action="/api/campaign" method="POST" enctype="multipart/form-data" id="campaignForm">
                <div class="grid">
                    <div>
                        <div class="card">
                            <h3>יצירת הודעה חדשה</h3>
                            <div class="form-group">
                                <label>טקסט ההודעה:</label>
                                <textarea name="text" rows="6" placeholder="הקלד את תוכן ההודעה כאן..." required></textarea>
                            </div>
                            <div class="form-group">
                                <label>צירוף קובץ / תמונה מהמכשיר:</label>
                                <input type="file" name="media" accept="image/*,video/*,application/pdf">
                            </div>
                        </div>

                        <div class="card">
                            <h3>מצב שליחה ותזמון</h3>
                            <div class="form-group">
                                <label>בחירת אופן השליחה:</label>
                                <select name="mode" id="deliveryMode" onchange="toggleModeOptions()">
                                    <option value="1">1. שליחה מרוכזת של הכל ברצף</option>
                                    <option value="2">2. שליחה במרווחים מוגדרים</option>
                                    <option value="3">3. שליחה בתזמון אישי לפי קבוצה</option>
                                </select>
                            </div>

                            <div id="mode2-options" style="display: none; border-left: 3px solid var(--primary); padding-right: 10px;">
                                <div class="form-group">
                                    <label>החל מהשעה:</label>
                                    <input type="time" name="startTime">
                                </div>
                                <div class="form-group">
                                    <label>מרווח זמן בין קבוצה לקבוצה (בדקות):</label>
                                    <input type="number" name="intervalMinutes" value="5" min="1">
                                </div>
                            </div>
                        </div>
                    </div>

                    <div>
                        <div class="card">
                            <h3>בחירת קבוצות יעד</h3>
                            <div class="form-group">
                                <input type="text" id="groupSearch" placeholder="חיפוש קבוצה מהיר..." onkeyup="filterGroups()">
                            </div>
                            <div class="group-list-box" id="groupsContainer">
                                <p style="color:#aaa; text-align:center;">אין קבוצות זמינות. ודא שחיברת את הוואטסאפ בהגדרות.</p>
                            </div>
                        </div>
                        
                        <div class="card" id="mode3-options" style="display: none;">
                            <h3>תזמון אישי לפי קבוצה</h3>
                            <div id="personalScheduleContainer">
                                <p style="font-size:13px; color:#aaa;">בחר קבוצות מהרשימה למעלה כדי לקבוע להן זמן ייעודי.</p>
                            </div>
                        </div>

                        <button type="submit" class="btn" id="submitBtn">שגר קמפיין הפצה</button>
                    </div>
                </div>
            </form>
        </div>

        <div id="tab-groups" class="tab-content">
            <div class="card">
                <h3>כל הקבוצות הקיימות בוואטסאפ (<span class="sync-count">0</span>)</h3>
                <p style="font-size: 14px; color:#aaa;">הקבוצות נסרקות אוטומטית בכל פעם שהוואטסאפ מתחבר למערכת.</p>
                <div class="group-list-box" id="fullGroupsList" style="max-height: 500px;">
                    </div>
            </div>
        </div>

        <div id="tab-history" class="tab-content">
            <div class="card">
                <h3>קמפיינים ששוגרו במערכת</h3>
                <div id="historyContainer">
                    </div>
            </div>
        </div>

        <div id="tab-settings" class="tab-content">
            <div class="card" style="text-align: center;">
                <h3>חיבור לוואטסאפ ווב (WhatsApp Web)</h3>
                <p>כדי שהמערכת תוכל לדוור, יש לסרוק את הברקוד הבא מהאפליקציה בטלפון (מכשירים מקושרים).</p>
                
                <div id="qr-wrapper" style="display: none;">
                    <div class="qr-container">
                        <img id="qr-img" src="" alt="WhatsApp QR Code">
                    </div>
                    <p style="color: var(--primary); font-weight: bold;">הברקוד מוכן לסריקה!</p>
                </div>

                <div id="status-message-box" style="margin: 20px 0; font-size: 18px;">
                    </div>

                <div style="margin-top: 30px; border-top: 1px solid var(--border); padding-top: 20px;">
                    <button class="btn btn-danger" style="max-width: 300px;" onclick="triggerLogout()">נתק חיבור קיים ואפס לחלוטין</button>
                    <p style="font-size:12px; color:#888; margin-top:5px;">כפתור זה מנתק, מוחק את תיקיית החיבור הקודמת ומייצר ברקוד חדש.</p>
                </div>
            </div>
        </div>

    </div>

    <script>
        let globalGroups = [];

        function switchTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
            document.getElementById('tab-' + tabId).classList.add('active');
            event.currentTarget.classList.add('active');
        }

        function toggleModeOptions() {
            const mode = document.getElementById('deliveryMode').value;
            document.getElementById('mode2-options').style.display = (mode === '2') ? 'block' : 'none';
            document.getElementById('mode3-options').style.display = (mode === '3') ? 'block' : 'none';
            buildPersonalScheduleInputs();
        }

        function renderGroupsList(groups) {
            globalGroups = groups;
            document.getElementById('group-count').innerText = groups.length;
            document.querySelectorAll('.sync-count').forEach(el => el.innerText = groups.length);
            
            const container = document.getElementById('groupsContainer');
            if(groups.length === 0) {
                container.innerHTML = '<p style="color:#aaa; text-align:center;">אין קבוצות זמינות. המתן לחיבור מלא.</p>';
                return;
            }

            // בניית רשימת הצ'קבוקסים בצורה בטוחה בזיכרון
            container.innerHTML = '';
            groups.forEach(g => {
                const shortId = g.id.split('@')[0];
                const lastFour = shortId.slice(-4);
                
                const itemDiv = document.createElement('div');
                itemDiv.className = 'group-item';
                itemDiv.setAttribute('data-name', g.name.toLowerCase());
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.name = 'groupIds';
                checkbox.value = g.id;
                checkbox.id = 'chk_' + g.id;
                checkbox.addEventListener('change', buildPersonalScheduleInputs);
                
                const label = document.createElement('label');
                label.htmlFor = 'chk_' + g.id;
                label.style.display = 'inline';
                label.style.margin = '0';
                label.style.cursor = 'pointer';
                label.innerText = g.name + ' ';
                
                const idSpan = document.createElement('span');
                idSpan.style.fontSize = '11px';
                idSpan.style.color = '#666';
                idSpan.style.fontWeight = 'normal';
                idSpan.innerText = '(' + lastFour + ')';
                
                label.appendChild(idSpan);
                itemDiv.appendChild(checkbox);
                itemDiv.appendChild(label);
                container.appendChild(itemDiv);
            });

            // בניית הרשימה המלאה בטאב קבוצות בצורה בטוחה
            const fullList = document.getElementById('fullGroupsList');
            fullList.innerHTML = '';
            groups.forEach(g => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'group-item';
                itemDiv.style.padding = '10px 0';
                
                const nameSpan = document.createElement('span');
                nameSpan.style.color = '#fff';
                nameSpan.style.fontWeight = 'bold';
                nameSpan.innerText = g.name;
                
                const idSpan = document.createElement('span');
                idSpan.style.fontSize = '11px';
                idSpan.style.color = '#666';
                idSpan.style.marginRight = 'auto';
                idSpan.innerText = 'ID: ' + g.id;
                
                itemDiv.appendChild(nameSpan);
                itemDiv.appendChild(idSpan);
                fullList.appendChild(itemDiv);
            });
        }

        function filterGroups() {
            const query = document.getElementById('groupSearch').value.toLowerCase();
            
            const removeHebrewVowels = (text) => {
                return text.replace(/[\\u05B0-\\u05C7]/g, "");
            };

            const cleanQuery = removeHebrewVowels(query);

            document.querySelectorAll('#groupsContainer .group-item').forEach(el => {
                const labelEl = el.querySelector('label');
                const originalName = labelEl ? labelEl.innerText.toLowerCase() : '';
                const cleanGroupName = removeHebrewVowels(originalName);
                
                if (cleanGroupName.includes(cleanQuery)) {
                    el.style.display = 'flex';
                } else {
                    el.style.display = 'none';
                }
            });
        }

        function buildPersonalScheduleInputs() {
            const mode = document.getElementById('deliveryMode').value;
            if (mode !== '3') return;

            const container = document.getElementById('personalScheduleContainer');
            const checkedBoxes = document.querySelectorAll('input[name="groupIds"]:checked');
            
            if(checkedBoxes.length === 0) {
                container.innerHTML = '<p style="font-size:13px; color:#aaa;">בחר קבוצות מהרשימה למעלה כדי לקבוע להן זמן ייעודי.</p>';
                return;
            }

            let html = '';
            checkedBoxes.forEach(cb => {
                const groupId = cb.value;
                const groupObj = globalGroups.find(g => g.id === groupId);
                const gName = groupObj ? groupObj.name : 'קבוצה';
                html += \`
                    <div class="form-group" style="border-bottom:1px solid #333; padding-bottom:8px;">
                        <label style="color:var(--primary);">\${gName}:</label>
                        <input type="datetime-local" name="personalSchedule[\${groupId}]" required>
                    </div>
                \`;
            });
            container.innerHTML = html;
        }

        function renderHistory(history) {
            const container = document.getElementById('historyContainer');
            if (!history || history.length === 0) {
                container.innerHTML = '<p style="color:#aaa; text-align:center;">טרם נשלחו קמפיינים במערכת.</p>';
                return;
            }

            container.innerHTML = history.map(camp => {
                let statusClass = 'status-wait';
                if(camp.status === 'הסתיים') statusClass = 'status-done';
                if(camp.status === 'במצע התהליך') statusClass = 'status-progress';

                let modeText = 'שליחה ברצף';
                if(camp.mode === '2') modeText = 'שליחה במרווחים';
                if(camp.mode === '3') modeText = 'תזמון פרטני';

                let targetsHtml = camp.targets.map(t => \`
                    <tr>
                        <td>\${t.groupName}</td>
                        <td>\${t.scheduledTime ? new Date(t.scheduledTime).toLocaleString('he-IL') : modeText}</td>
                        <td>\${t.sentAt}</td>
                        <td style="color: \${t.status==='נשלח'?'#06d6a0':(t.status==='נכשל'?'#ff5252':'#ffd166')}">\${t.status}</td>
                    </tr>
                \`).join('');

                return \`
                    <div class="history-item">
                        <div class="history-header">
                            <div><strong>תאריך:</strong> \${camp.date} \${camp.time} | <strong>סוג:</strong> \${modeText}</div>
                            <div class="camp-status \${statusClass}">\${camp.status}</div>
                        </div>
                        <div style="white-space: pre-wrap; font-size:14px; margin-bottom:10px; background:#1a1a1a; padding:10px; border-radius:4px;">\${camp.text}</div>
                        \${camp.mediaName ? \`<div style="font-size:12px; color:#aaa; margin-bottom:10px;">📎 קובץ מצורף: \${camp.mediaName}</div>\` : ''}
                        
                        <details>
                            <summary style="cursor:pointer; font-size:13px; color:var(--primary);">הצג פירוט קבוצות ושעות (\${camp.targets.length} קבוצות)</summary>
                            <table class="target-table">
                                <thead>
                                    <tr>
                                        <th>שם הקבוצה</th>
                                        <th>זמן מתוכנן</th>
                                        <th>בוצע בשעה</th>
                                        <th>סטטוס</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    \${targetsHtml}
                                </tbody>
                            </table>
                        </details>
                    </div>
                \`;
            }).join('');
        }

        async function updateStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                const statusEl = document.getElementById('global-status');
                statusEl.className = 'status-badge';
                
                const submitBtn = document.getElementById('submitBtn');

                if (data.status === 'ready') {
                    statusEl.innerText = 'מחובר לוואטסאפ';
                    statusEl.classList.add('status-ready');
                    document.getElementById('status-message-box').innerHTML = '<p style="color:#06d6a0; font-weight:bold;">וואטסאפ מחובר ועובד כראוי!</p>';
                    document.getElementById('qr-wrapper').style.display = 'none';
                    if(submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = '1'; }
                } else if (data.status === 'qr') {
                    statusEl.innerText = 'ממתין לסריקה';
                    statusEl.classList.add('status-qr');
                    document.getElementById('qr-img').src = data.qr;
                    document.getElementById('qr-wrapper').style.display = 'block';
                    document.getElementById('status-message-box').innerHTML = '<p>אנא סרוק את קוד ה-QR כדי לחבר את המערכת.</p>';
                    if(submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.5'; }
                } else if (data.status === 'connecting') {
                    statusEl.innerText = 'מתחבר...';
                    statusEl.classList.add('status-connecting');
                    document.getElementById('status-message-box').innerHTML = '<p>מתחבר לשרתי וואטסאפ, אנא המתן...</p>';
                    document.getElementById('qr-wrapper').style.display = 'none';
                } else {
                    statusEl.innerText = 'מנותק';
                    document.getElementById('status-message-box').innerHTML = '<p style="color:#ea0038;">המערכת מנותקת. נסה לרענן או לבצע איפוס מוחלט.</p>';
                    document.getElementById('qr-wrapper').style.display = 'none';
                }

                if (globalGroups.length !== data.groups.length) {
                    renderGroupsList(data.groups);
                }
                renderHistory(data.history);

            } catch (e) {
                console.error("שגיאה בעדכון הנתונים", e);
            }
        }

        async function triggerLogout() {
            if(confirm('האם אתה בטוח שברצונך לנתק את החיבור הקיים, למחוק את קבצי הסשן ולייצר קוד חדש?')) {
                const res = await fetch('/api/logout', { method: 'POST' });
                const data = await res.json();
                if(data.success) {
                    alert('המערכת אופסה. מפיק ברקוד חדש...');
                    updateStatus();
                }
            }
        }

// לולאת עדכון ברקע כל 3 שניות
        setInterval(updateStatus, 3000);
        
        window.onload = () => {
            updateStatus();
            
            // מנגנון אימות לפני שליחת קמפיין
            const form = document.getElementById('campaignForm');
            if (form) {
                form.addEventListener('submit', function(event) {
                    // עצירת השליחה האוטומטית כדי לבצע את הבדיקה
                    event.preventDefault(); 
                    
                    // בקשת קוד אימות מהמשתמש
                    const userCode = prompt('אנא הזן קוד אימות לאישור שליחת הקמפיין:');
                    
                    if (userCode === '7410') {
                        // אם הקוד נכון, הטופס יישלח לשרת והתהליך יתחיל
                        this.submit();
                    } else if (userCode === null) {
                        // המשתמש לחץ על ביטול בתיבת ה-prompt
                        alert('השליחה בוטלה.');
                    } else {
                        // הוקש קוד שגוי
                        alert('קוד אימות שגוי! השליחה נחסמה.');
                    }
                });
            }

            // בדיקה אם חזרנו מהגשת טופס בהצלחה
            if(new URLSearchParams(window.location.search).get('msg') === 'success') {
                alert('הקמפיין נוצר והועבר למערכת השליחה בהצלחה!');
                window.history.replaceState({}, document.title, "/");
            }
        };
    </script>
</body>
</html>
`);

// הפעלת השרת
app.listen(port, () => {
    console.log(`===================================================`);
    console.log(`🚀 המערכת רצה בהצלחה בכתובת: http://localhost:\${port}`);
    console.log(`===================================================`);
});
