const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Database setup
const dbPath = process.env.DB_PATH || path.join(__dirname, 'rates.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to SQLite database');
});

// Initialize database schema
function initializeDatabase() {
  db.serialize(() => {
    // Daily rates table
    db.run(`
      CREATE TABLE IF NOT EXISTS daily_rates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE NOT NULL,
        conventional_purchase REAL,
        conventional_refi REAL,
        fha_rate REAL,
        va_rate REAL,
        jumbo_rate REAL,
        scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Historical alerts table
    db.run(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT,
        message TEXT,
        rate_value REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        sent BOOLEAN DEFAULT 0
      )
    `);

    // Forecasts table
    db.run(`
      CREATE TABLE IF NOT EXISTS forecasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        forecast_date TEXT,
        days_ahead INTEGER,
        predicted_rate REAL,
        confidence_level REAL,
        analysis TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // External data table (for correlations)
    db.run(`
      CREATE TABLE IF NOT EXISTS external_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        event_type TEXT,
        event_name TEXT,
        impact_direction TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
}

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ============ RATE SCRAPING ============

async function scrapeRates() {
  try {
    console.log('Starting rate scrape...');

    // Try web scraping first (if Dream For All has a website)
    let rates = await scrapeDreamForAllRates();

    if (!rates) {
      console.log('Falling back to mock data for demo');
      rates = generateMockRates();
    }

    // Store in database
    await storeRates(rates);

    // Check for alerts
    await checkForAlerts(rates);

    // Generate forecast
    await generateForecast();

    // Send email
    await sendDailyEmail(rates);

    return rates;
  } catch (error) {
    console.error('Rate scraping error:', error);
    sendErrorEmail(error);
  }
}

async function scrapeDreamForAllRates() {
  try {
    // This would scrape Dream For All's website
    // Using Puppeteer if JavaScript-heavy, axios if simple HTML
    const url = process.env.DREAM_FOR_ALL_URL || 'https://www.dreamforall.com'; // Replace with actual URL

    // Attempt with axios first (faster)
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });

    // Parse rates from HTML (adjust selectors to match actual site)
    const conventionalPurchase = parseFloat(extractRate(response.data, 'conventional-purchase'));
    const conventionalRefi = parseFloat(extractRate(response.data, 'conventional-refi'));

    if (isNaN(conventionalPurchase) || isNaN(conventionalRefi)) {
      return null;
    }

    return {
      date: new Date().toISOString().split('T')[0],
      conventional_purchase: conventionalPurchase,
      conventional_refi: conventionalRefi,
      fha_rate: conventionalPurchase + 0.25,
      va_rate: conventionalPurchase - 0.15,
      jumbo_rate: conventionalPurchase + 0.5
    };
  } catch (error) {
    console.error('Scraping error:', error.message);
    return null;
  }
}

async function scrapeDreamForAllWithPuppeteer() {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(process.env.DREAM_FOR_ALL_URL || 'https://www.dreamforall.com', { waitUntil: 'networkidle2' });

    const rates = await page.evaluate(() => {
      const conventional = document.querySelector('[data-rate="conventional"]');
      return {
        conventional_purchase: parseFloat(conventional?.textContent || 0),
      };
    });

    return rates;
  } catch (error) {
    console.error('Puppeteer error:', error);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

function extractRate(html, type) {
  // Regex to find rates (looks for 6.25%, 6.5%, etc)
  const regex = /(\d+\.\d{2})%/g;
  const matches = html.match(regex);
  return matches ? matches[0] : '0';
}

function generateMockRates() {
  // For demo/testing when real scraping fails
  const baseRate = 6.5;
  const variance = (Math.random() - 0.5) * 0.2;

  return {
    date: new Date().toISOString().split('T')[0],
    conventional_purchase: parseFloat((baseRate + variance).toFixed(3)),
    conventional_refi: parseFloat((baseRate + variance - 0.1).toFixed(3)),
    fha_rate: parseFloat((baseRate + variance + 0.25).toFixed(3)),
    va_rate: parseFloat((baseRate + variance - 0.15).toFixed(3)),
    jumbo_rate: parseFloat((baseRate + variance + 0.5).toFixed(3))
  };
}

function storeRates(rates) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO daily_rates (date, conventional_purchase, conventional_refi, fha_rate, va_rate, jumbo_rate)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [rates.date, rates.conventional_purchase, rates.conventional_refi, rates.fha_rate, rates.va_rate, rates.jumbo_rate],
      function(err) {
        if (err) {
          console.error('Database insert error:', err);
          reject(err);
        } else {
          console.log(`Rates stored for ${rates.date}`);
          resolve();
        }
      }
    );
  });
}

// ============ ALERT SYSTEM ============

async function checkForAlerts(rates) {
  const alerts = [];

  // Get previous rate
  const previousRate = await getPreviousRate('conventional_purchase');

  if (previousRate) {
    const change = rates.conventional_purchase - previousRate;

    // Volatility alert
    if (Math.abs(change) > (parseFloat(process.env.ALERT_VOLATILITY_THRESHOLD) || 0.5)) {
      alerts.push({
        type: 'VOLATILITY',
        message: `Major rate movement: ${change > 0 ? '+' : ''}${change.toFixed(3)}% in 24h`,
        rate_value: rates.conventional_purchase
      });
    }
  }

  // Rate threshold alerts
  const thresholdHigh = parseFloat(process.env.ALERT_THRESHOLD_HIGH) || 7.5;
  const thresholdLow = parseFloat(process.env.ALERT_THRESHOLD_LOW) || 5.5;

  if (rates.conventional_purchase > thresholdHigh) {
    alerts.push({
      type: 'THRESHOLD',
      message: `Rate elevated: ${rates.conventional_purchase}% (above ${thresholdHigh}%)`,
      rate_value: rates.conventional_purchase
    });
  }

  if (rates.conventional_purchase < thresholdLow) {
    alerts.push({
      type: 'THRESHOLD',
      message: `Rate low: ${rates.conventional_purchase}% (below ${thresholdLow}%)`,
      rate_value: rates.conventional_purchase
    });
  }

  // Store alerts
  alerts.forEach(alert => {
    db.run(
      `INSERT INTO alerts (type, message, rate_value) VALUES (?, ?, ?)`,
      [alert.type, alert.message, alert.rate_value]
    );
  });

  return alerts;
}

function getPreviousRate(rateType) {
  return new Promise((resolve) => {
    db.get(
      `SELECT ${rateType} FROM daily_rates ORDER BY date DESC LIMIT 2 OFFSET 1`,
      (err, row) => {
        resolve(row ? row[rateType] : null);
      }
    );
  });
}

// ============ FORECAST & ANALYSIS ============

async function generateForecast() {
  try {
    // Get last 30 days of rates
    const historicalData = await getHistoricalRates(30);

    if (historicalData.length < 7) {
      console.log('Insufficient historical data for forecast');
      return;
    }

    // Prepare data for Claude analysis
    const ratesText = historicalData
      .map(d => `${d.date}: ${d.conventional_purchase}%`)
      .join('\n');

    // Call Claude for AI forecast
    const prompt = `You are a mortgage rate analyst. Analyze these historical rates and provide:
1. A 7-day rate forecast with specific predictions
2. Confidence level (0-1) for each prediction
3. Key trends and patterns observed
4. Factors that might influence future rates

Historical rates (past 30 days):
${ratesText}

Respond in JSON format:
{
  "forecast_7day": [{"day": 1, "predicted_rate": X.XX, "confidence": 0.8}, ...],
  "analysis": "...",
  "key_trends": ["...", "..."],
  "factors": ["...", "..."]
}`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-20250805',
      max_tokens: 1000,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const analysisText = response.content[0].text;

    // Extract JSON from response
    const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);

      // Store forecasts
      analysis.forecast_7day.forEach((forecast, index) => {
        db.run(
          `INSERT INTO forecasts (forecast_date, days_ahead, predicted_rate, confidence_level, analysis)
           VALUES (?, ?, ?, ?, ?)`,
          [
            new Date().toISOString().split('T')[0],
            forecast.day,
            forecast.predicted_rate,
            forecast.confidence,
            JSON.stringify(analysis)
          ]
        );
      });
    }
  } catch (error) {
    console.error('Forecast generation error:', error);
  }
}

async function getHistoricalRates(days) {
  return new Promise((resolve) => {
    db.all(
      `SELECT date, conventional_purchase, conventional_refi, fha_rate, va_rate, jumbo_rate FROM daily_rates
       ORDER BY date DESC LIMIT ?`,
      [days],
      (err, rows) => {
        resolve(rows ? rows.reverse() : []);
      }
    );
  });
}

// ============ EMAIL SENDING ============

async function sendDailyEmail(rates) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD || !process.env.EMAIL_RECIPIENTS) {
    console.log('Email not configured, skipping...');
    return;
  }

  try {
    const historicalRates = await getHistoricalRates(7);
    const alerts = await getUnsentAlerts();
    const latestForecast = await getLatestForecast();

    const htmlContent = generateEmailHTML(rates, historicalRates, alerts, latestForecast);

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_RECIPIENTS,
      subject: `Mortgage Rate Update - ${new Date().toLocaleDateString()} | Dream For All`,
      html: htmlContent
    };

    await transporter.sendMail(mailOptions);
    console.log('Daily email sent');

    // Mark alerts as sent
    db.run(`UPDATE alerts SET sent = 1 WHERE sent = 0`);
  } catch (error) {
    console.error('Email sending error:', error);
  }
}

function generateEmailHTML(rates, historicalRates, alerts, forecast) {
  const previousRate = historicalRates.length > 1 ? historicalRates[historicalRates.length - 2].conventional_purchase : rates.conventional_purchase;
  const change = rates.conventional_purchase - previousRate;
  const trend = change > 0 ? '📈 UP' : change < 0 ? '📉 DOWN' : '➡️ STABLE';

  let alertsHTML = '';
  if (alerts.length > 0) {
    alertsHTML = `
      <div style="background: #FFF3CD; border-left: 4px solid #FFC107; padding: 15px; margin: 20px 0; border-radius: 4px;">
        <h3 style="margin-top: 0; color: #856404;">⚠️ Alerts</h3>
        ${alerts.map(a => `<p style="margin: 5px 0;"><strong>${a.type}:</strong> ${a.message}</p>`).join('')}
      </div>
    `;
  }

  let forecastHTML = '';
  if (forecast) {
    forecastHTML = `
      <div style="background: #E8F4F8; padding: 15px; margin: 20px 0; border-radius: 4px;">
        <h3 style="margin-top: 0; color: #0C5460;">📊 7-Day Forecast</h3>
        <p>${forecast.analysis}</p>
      </div>
    `;
  }

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #333; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 8px; text-align: center; }
          .rate-card { background: white; border: 2px solid #667eea; padding: 20px; margin: 20px 0; border-radius: 8px; }
          .rate-value { font-size: 36px; font-weight: bold; color: #667eea; }
          .rate-label { color: #666; margin-top: 10px; }
          .comparison { display: flex; justify-content: space-between; margin-top: 15px; font-size: 14px; }
          .comparison-item { flex: 1; }
          .footer { text-align: center; color: #999; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Mortgage Rate Update</h1>
            <p style="margin: 10px 0 0 0;">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
          </div>

          <div class="rate-card">
            <h2 style="margin-top: 0;">Today's Rates - Dream For All</h2>
            <div class="rate-value">${rates.conventional_purchase.toFixed(3)}%</div>
            <div class="rate-label">Conventional Purchase Rate</div>
            <div class="comparison">
              <div class="comparison-item">
                <strong>Change:</strong> ${change > 0 ? '+' : ''}${change.toFixed(3)}%
              </div>
              <div class="comparison-item">
                <strong>Trend:</strong> ${trend}
              </div>
              <div class="comparison-item">
                <strong>Refi Rate:</strong> ${rates.conventional_refi.toFixed(3)}%
              </div>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0;">
            <div style="background: #F8F9FA; padding: 15px; border-radius: 4px;">
              <div style="font-size: 14px; color: #666;">FHA Rate</div>
              <div style="font-size: 24px; font-weight: bold; color: #333;">${rates.fha_rate.toFixed(3)}%</div>
            </div>
            <div style="background: #F8F9FA; padding: 15px; border-radius: 4px;">
              <div style="font-size: 14px; color: #666;">VA Rate</div>
              <div style="font-size: 24px; font-weight: bold; color: #333;">${rates.va_rate.toFixed(3)}%</div>
            </div>
            <div style="background: #F8F9FA; padding: 15px; border-radius: 4px;">
              <div style="font-size: 14px; color: #666;">Jumbo Rate</div>
              <div style="font-size: 24px; font-weight: bold; color: #333;">${rates.jumbo_rate.toFixed(3)}%</div>
            </div>
            <div style="background: #F8F9FA; padding: 15px; border-radius: 4px;">
              <div style="font-size: 14px; color: #666;">Spread (Purch - Refi)</div>
              <div style="font-size: 24px; font-weight: bold; color: #333;">${(rates.conventional_purchase - rates.conventional_refi).toFixed(3)}%</div>
            </div>
          </div>

          ${alertsHTML}
          ${forecastHTML}

          <div style="background: #F8F9FA; padding: 15px; margin: 20px 0; border-radius: 4px;">
            <h3 style="margin-top: 0;">📈 7-Day Trend</h3>
            <table style="width: 100%; font-size: 14px;">
              <tr style="border-bottom: 1px solid #ddd;">
                <th style="text-align: left; padding: 5px;">Date</th>
                <th style="text-align: right; padding: 5px;">Rate</th>
                <th style="text-align: right; padding: 5px;">Change</th>
              </tr>
              ${historicalRates.map((r, i) => {
                const rateChange = i > 0 ? r.conventional_purchase - historicalRates[i-1].conventional_purchase : 0;
                return `
                  <tr style="border-bottom: 1px solid #eee;">
                    <td style="padding: 5px;">${r.date}</td>
                    <td style="text-align: right; padding: 5px;">${r.conventional_purchase.toFixed(3)}%</td>
                    <td style="text-align: right; padding: 5px; color: ${rateChange > 0 ? '#e74c3c' : rateChange < 0 ? '#27ae60' : '#95a5a6'};">
                      ${rateChange > 0 ? '+' : ''}${rateChange.toFixed(3)}%
                    </td>
                  </tr>
                `;
              }).join('')}
            </table>
          </div>

          <div class="footer">
            <p>Mortgage rate data from Dream For All | Forecast generated by AI analysis</p>
            <p>Unsubscribe or manage preferences in your email settings</p>
          </div>
        </div>
      </body>
    </html>
  `;
}

async function getUnsentAlerts() {
  return new Promise((resolve) => {
    db.all(`SELECT * FROM alerts WHERE sent = 0 LIMIT 10`, (err, rows) => {
      resolve(rows || []);
    });
  });
}

async function getLatestForecast() {
  return new Promise((resolve) => {
    db.get(
      `SELECT analysis FROM forecasts ORDER BY created_at DESC LIMIT 1`,
      (err, row) => {
        if (row && row.analysis) {
          try {
            resolve(JSON.parse(row.analysis));
          } catch {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      }
    );
  });
}

async function sendErrorEmail(error) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_RECIPIENTS) return;
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_RECIPIENTS,
      subject: '❌ Mortgage Rate Tracker - Error',
      html: `<h2>Error in rate tracking system</h2><p>${error.message}</p><pre>${error.stack}</pre>`
    };
    await transporter.sendMail(mailOptions);
  } catch (err) {
    console.error('Error email failed:', err);
  }
}

// ============ API ENDPOINTS ============

// Get current rates
app.get('/api/rates/current', (req, res) => {
  db.get(
    `SELECT * FROM daily_rates ORDER BY date DESC LIMIT 1`,
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(row || {});
    }
  );
});

// Get historical rates
app.get('/api/rates/historical', (req, res) => {
  const days = req.query.days || 30;
  db.all(
    `SELECT * FROM daily_rates ORDER BY date DESC LIMIT ?`,
    [days],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows ? rows.reverse() : []);
    }
  );
});

// Get statistics
app.get('/api/stats', (req, res) => {
  db.all(
    `SELECT * FROM daily_rates ORDER BY date DESC LIMIT 90`,
    (err, rows) => {
      if (!rows || rows.length === 0) return res.json({});

      const rates = rows.map(r => r.conventional_purchase).reverse();
      const min = Math.min(...rates);
      const max = Math.max(...rates);
      const avg = rates.reduce((a, b) => a + b) / rates.length;
      const current = rates[rates.length - 1];
      const change = current - rates[Math.max(0, rates.length - 8)];
      const movingAvg30 = rates.slice(-30).reduce((a, b) => a + b) / Math.min(30, rates.length);

      res.json({
        current,
        change,
        min,
        max,
        avg,
        movingAvg30,
        volatility: (Math.max(...rates.slice(-7)) - Math.min(...rates.slice(-7))).toFixed(3)
      });
    }
  );
});

// Get alerts
app.get('/api/alerts', (req, res) => {
  db.all(
    `SELECT * FROM alerts ORDER BY created_at DESC LIMIT 20`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// Get forecasts
app.get('/api/forecasts', (req, res) => {
  db.get(
    `SELECT * FROM forecasts ORDER BY created_at DESC LIMIT 1`,
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.json({});
      try {
        res.json(JSON.parse(row.analysis));
      } catch {
        res.json({});
      }
    }
  );
});

// Manual trigger for rate scraping
app.post('/api/scrape-rates', async (req, res) => {
  try {
    const rates = await scrapeRates();
    res.json({ success: true, rates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ SERVE REACT BUILD (PRODUCTION) ============

app.use(express.static(path.join(__dirname, 'build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

// ============ SCHEDULED JOBS ============

// Run at 10 AM PST daily (6 PM UTC)
const scheduleDailyRateScrape = () => {
  cron.schedule('0 18 * * *', async () => {
    console.log('Running scheduled rate scrape...');
    await scrapeRates();
  }, {
    timezone: 'America/Los_Angeles'
  });

  console.log('Scheduled rate scrape at 10 AM PST daily');
};

// ============ SERVER STARTUP ============

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initializeDatabase();
  scheduleDailyRateScrape();

  // Run scraper once on startup
  console.log('Triggering initial rate scrape...');
  scrapeRates().catch(console.error);
});

module.exports = app;
