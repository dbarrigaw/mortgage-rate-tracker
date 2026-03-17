import React, { useState, useEffect } from 'react';
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart } from 'recharts';
import { TrendingUp, TrendingDown, AlertCircle, Eye, BarChart3, Calendar, Zap, Target } from 'lucide-react';
import './Dashboard.css';

const Dashboard = () => {
  const [currentRates, setCurrentRates] = useState(null);
  const [historicalRates, setHistoricalRates] = useState([]);
  const [stats, setStats] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [forecasts, setForecasts] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [timeRange, setTimeRange] = useState(30);
  const [loading, setLoading] = useState(true);

  // Empty string = relative URLs, works with proxy in dev and Express static in prod
  const API_BASE = '';

  // Fetch all data
  useEffect(() => {
    fetchAllData();
    const interval = setInterval(fetchAllData, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, [timeRange]);

  const fetchAllData = async () => {
    try {
      setLoading(true);
      const [currentRes, historicalRes, statsRes, alertsRes, forecastsRes] = await Promise.all([
        fetch(`${API_BASE}/api/rates/current`),
        fetch(`${API_BASE}/api/rates/historical?days=${timeRange}`),
        fetch(`${API_BASE}/api/stats`),
        fetch(`${API_BASE}/api/alerts`),
        fetch(`${API_BASE}/api/forecasts`)
      ]);

      const current = await currentRes.json();
      const historical = await historicalRes.json();
      const statsData = await statsRes.json();
      const alertsData = await alertsRes.json();
      const forecastsData = await forecastsRes.json();

      setCurrentRates(current);
      setHistoricalRates(historical);
      setStats(statsData);
      setAlerts(alertsData);
      setForecasts(forecastsData);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching data:', error);
      setLoading(false);
    }
  };

  const triggerManualScrape = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/scrape-rates`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        fetchAllData();
      }
    } catch (error) {
      console.error('Scrape error:', error);
    }
  };

  if (loading && !currentRates) {
    return <div className="dashboard-loading">Loading mortgage rate data...</div>;
  }

  const rateChange = currentRates && historicalRates.length > 1
    ? currentRates.conventional_purchase - historicalRates[0].conventional_purchase
    : 0;

  const trendDirection = rateChange > 0 ? 'up' : rateChange < 0 ? 'down' : 'stable';

  return (
    <div className="dashboard">
      {/* Header */}
      <div className="dashboard-header">
        <div className="header-content">
          <h1 className="dashboard-title">💰 Mortgage Rate Tracker</h1>
          <p className="dashboard-subtitle">Dream For All | Real-time Analysis & AI Forecasts</p>
        </div>
        <div className="header-actions">
          <button className="btn-refresh" onClick={fetchAllData}>⟳ Refresh</button>
          <button className="btn-scrape" onClick={triggerManualScrape}>📊 Scrape Now</button>
        </div>
      </div>

      {/* Live Rate Card */}
      <div className="rate-hero">
        <div className="rate-main-card">
          <div className="rate-label">Dream For All Conventional</div>
          <div className="rate-value">{currentRates?.conventional_purchase?.toFixed(3)}%</div>

          <div className="rate-subinfo">
            <div className={`rate-change ${trendDirection}`}>
              {trendDirection === 'up' && <TrendingUp size={16} />}
              {trendDirection === 'down' && <TrendingDown size={16} />}
              <span>{rateChange > 0 ? '+' : ''}{rateChange.toFixed(3)}%</span>
              <span className="change-label">vs 7 days ago</span>
            </div>

            <div className="rate-details-grid">
              <div className="detail-box">
                <span className="detail-label">Dream For All Refi</span>
                <span className="detail-value">{currentRates?.conventional_refi?.toFixed(3)}%</span>
              </div>
              <div className="detail-box">
                <span className="detail-label">Spread</span>
                <span className="detail-value">{(currentRates?.conventional_purchase - currentRates?.conventional_refi)?.toFixed(3)}%</span>
              </div>
              <div className="detail-box">
                <span className="detail-label">30-Day Avg</span>
                <span className="detail-value">{stats?.movingAvg30?.toFixed(3)}%</span>
              </div>
              <div className="detail-box">
                <span className="detail-label">90-Day Range</span>
                <span className="detail-value">{stats?.min?.toFixed(3)}% - {stats?.max?.toFixed(3)}%</span>
              </div>
            </div>

            <div className="other-rates">
              <div className="other-rate-item">
                <span className="rate-type">Conventional LI</span>
                <span className="rate-num">{currentRates?.fha_rate?.toFixed(3)}%</span>
              </div>
              <div className="other-rate-item">
                <span className="rate-type">Refi</span>
                <span className="rate-num">{currentRates?.va_rate?.toFixed(3)}%</span>
              </div>
              <div className="other-rate-item">
                <span className="rate-type">Conventional</span>
                <span className="rate-num">{currentRates?.jumbo_rate?.toFixed(3)}%</span>
              </div>
            </div>
          </div>

          <div className="last-updated">
            Last updated: {currentRates?.date}
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="tab-navigation">
        <button
          className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          <Eye size={18} /> Overview
        </button>
        <button
          className={`tab ${activeTab === 'analytics' ? 'active' : ''}`}
          onClick={() => setActiveTab('analytics')}
        >
          <BarChart3 size={18} /> Analytics
        </button>
        <button
          className={`tab ${activeTab === 'forecast' ? 'active' : ''}`}
          onClick={() => setActiveTab('forecast')}
        >
          <Target size={18} /> Forecast
        </button>
        <button
          className={`tab ${activeTab === 'alerts' ? 'active' : ''}`}
          onClick={() => setActiveTab('alerts')}
        >
          <AlertCircle size={18} /> Alerts ({alerts.length})
        </button>
      </div>

      {/* Content Tabs */}
      <div className="tab-content">

        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="tab-panel">
            <div className="section">
              <div className="section-header">
                <h2>Rate Trend</h2>
                <div className="time-range-selector">
                  <button
                    className={timeRange === 7 ? 'active' : ''}
                    onClick={() => setTimeRange(7)}
                  >
                    7D
                  </button>
                  <button
                    className={timeRange === 30 ? 'active' : ''}
                    onClick={() => setTimeRange(30)}
                  >
                    30D
                  </button>
                  <button
                    className={timeRange === 90 ? 'active' : ''}
                    onClick={() => setTimeRange(90)}
                  >
                    90D
                  </button>
                </div>
              </div>

              <ResponsiveContainer width="100%" height={400}>
                <AreaChart data={historicalRates} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorRate" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#667eea" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#667eea" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12 }}
                    stroke="#999"
                  />
                  <YAxis
                    domain={['dataMin - 0.2', 'dataMax + 0.2']}
                    tick={{ fontSize: 12 }}
                    stroke="#999"
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '4px' }}
                    formatter={(value) => `${value.toFixed(3)}%`}
                  />
                  <Area
                    type="monotone"
                    dataKey="conventional_purchase"
                    stroke="#667eea"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorRate)"
                    name="Purchase Rate"
                  />
                  <Area
                    type="monotone"
                    dataKey="conventional_refi"
                    stroke="#764ba2"
                    strokeWidth={2}
                    fillOpacity={0.1}
                    name="Refi Rate"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Quick Stats */}
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon">📊</div>
                <div className="stat-content">
                  <div className="stat-label">Current Rate</div>
                  <div className="stat-value">{currentRates?.conventional_purchase?.toFixed(3)}%</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">⬆️</div>
                <div className="stat-content">
                  <div className="stat-label">7-Day High</div>
                  <div className="stat-value">{stats?.max?.toFixed(3)}%</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">⬇️</div>
                <div className="stat-content">
                  <div className="stat-label">7-Day Low</div>
                  <div className="stat-value">{stats?.min?.toFixed(3)}%</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">📈</div>
                <div className="stat-content">
                  <div className="stat-label">Volatility</div>
                  <div className="stat-value">{stats?.volatility}%</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ANALYTICS TAB */}
        {activeTab === 'analytics' && (
          <div className="tab-panel">
            <div className="section">
              <h2>Detailed Analytics</h2>

              <div className="analytics-grid">
                <div className="analytics-chart">
                  <h3>Rate Distribution (90 days)</h3>
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={historicalRates}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                      <YAxis />
                      <Tooltip formatter={(value) => `${value.toFixed(3)}%`} />
                      <Legend />
                      <Bar dataKey="conventional_purchase" fill="#667eea" name="Purchase" />
                      <Bar dataKey="conventional_refi" fill="#764ba2" name="Refi" />
                      <Bar dataKey="fha_rate" fill="#f093fb" name="FHA" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <div className="analytics-stats">
                  <h3>Statistical Summary</h3>
                  <div className="stat-list">
                    <div className="stat-item">
                      <span className="stat-name">Current Rate</span>
                      <span className="stat-val">{currentRates?.conventional_purchase?.toFixed(3)}%</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-name">30-Day Average</span>
                      <span className="stat-val">{stats?.movingAvg30?.toFixed(3)}%</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-name">90-Day Average</span>
                      <span className="stat-val">{stats?.avg?.toFixed(3)}%</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-name">90-Day High</span>
                      <span className="stat-val">{stats?.max?.toFixed(3)}%</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-name">90-Day Low</span>
                      <span className="stat-val">{stats?.min?.toFixed(3)}%</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-name">7-Day Volatility</span>
                      <span className="stat-val">{stats?.volatility}%</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-name">Purch - Refi Spread</span>
                      <span className="stat-val">{(currentRates?.conventional_purchase - currentRates?.conventional_refi)?.toFixed(3)}%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* FORECAST TAB */}
        {activeTab === 'forecast' && (
          <div className="tab-panel">
            <div className="section">
              <h2>AI-Powered 7-Day Forecast</h2>

              {forecasts && forecasts.forecast_7day ? (
                <div className="forecast-content">
                  <div className="forecast-analysis">
                    <h3>Analysis</h3>
                    <p>{forecasts.analysis || 'No analysis available yet'}</p>
                  </div>

                  {forecasts.key_trends && (
                    <div className="forecast-section">
                      <h3>Key Trends</h3>
                      <ul className="trends-list">
                        {forecasts.key_trends.map((trend, idx) => (
                          <li key={idx}>📌 {trend}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {forecasts.factors && (
                    <div className="forecast-section">
                      <h3>Influencing Factors</h3>
                      <ul className="factors-list">
                        {forecasts.factors.map((factor, idx) => (
                          <li key={idx}>⚡ {factor}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="forecast-section">
                    <h3>7-Day Predictions</h3>
                    <div className="forecast-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Day</th>
                            <th>Predicted Rate</th>
                            <th>Confidence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {forecasts.forecast_7day.map((f, idx) => (
                            <tr key={idx}>
                              <td>Day {f.day}</td>
                              <td className="forecast-rate">{f.predicted_rate?.toFixed(3)}%</td>
                              <td>
                                <div className="confidence-bar">
                                  <div
                                    className="confidence-fill"
                                    style={{ width: `${f.confidence * 100}%` }}
                                  ></div>
                                </div>
                                {(f.confidence * 100).toFixed(0)}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="no-data">No forecast data available yet. Check back after the first data collection.</div>
              )}
            </div>
          </div>
        )}

        {/* ALERTS TAB */}
        {activeTab === 'alerts' && (
          <div className="tab-panel">
            <div className="section">
              <h2>System Alerts</h2>

              {alerts.length > 0 ? (
                <div className="alerts-list">
                  {alerts.map((alert) => (
                    <div key={alert.id} className={`alert-item alert-${alert.type.toLowerCase()}`}>
                      <div className="alert-header">
                        <span className="alert-type">{alert.type}</span>
                        <span className="alert-time">{new Date(alert.created_at).toLocaleString()}</span>
                      </div>
                      <p className="alert-message">{alert.message}</p>
                      {alert.rate_value && (
                        <div className="alert-meta">Rate: {alert.rate_value.toFixed(3)}%</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="no-data">No alerts at this time. Keep monitoring for rate changes!</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="dashboard-footer">
        <p>📊 Mortgage Rate Data • 🤖 AI-Powered Analysis • 📧 Daily Emails at 10 AM PST</p>
        <p style={{ fontSize: '12px', marginTop: '8px', opacity: 0.7 }}>Last sync: {new Date().toLocaleTimeString()}</p>
      </div>
    </div>
  );
};

export default Dashboard;
