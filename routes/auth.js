const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB, runQuery, runRun, getLastInsertId } = require('../db/init');
const { authMiddleware, signToken } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    await getDB();
    const hash = bcrypt.hashSync(password, 10);
    runRun('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)', [username, email, hash]);
    const id = getLastInsertId();
    const token = signToken(id);
    res.status(201).json({ token, user: { id, username, email } });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Registration failed', details: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    await getDB();
    const { results } = runQuery('SELECT * FROM users WHERE email = ?', [email]);
    const user = results[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = signToken(user.id);
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed', details: err.message });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    await getDB();
    const { results } = runQuery('SELECT id, username, email, created_at FROM users WHERE id = ?', [req.userId]);
    const user = results[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('[Auth] /me error:', err.message);
    res.status(500).json({ error: 'Failed to get user', details: err.message });
  }
});

module.exports = router;
