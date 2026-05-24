# שימוש באימג' רשמי של Puppeteer שמגיע עם דפדפן Chromium מובנה וכל חבילות הלינוקס הנדרשות
FROM ghcr.io/puppeteer/puppeteer:latest

# מעבר למשתמש root כדי שנוכל לנהל את הקבצים בתיקייה
USER root

# הגדרת תיקיית העבודה בשרת
WORKDIR /app

# העתקת קבצי הפרויקט והתקנת חבילות
COPY package*.json ./
RUN npm install
# העתקת שאר הקוד
COPY . .

# פקודת ההרצה של השרת
CMD ["node", "app.js"]
