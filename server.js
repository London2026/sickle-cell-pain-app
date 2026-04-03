const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { OpenAI } = require('openai');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY_HERE';
const MONGO_URI = process.env.MONGODB_URI || 'YOUR_MONGODB_CONNECTION_STRING'; 

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- MONGODB CONNECTION ---
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB Connected');
    seedData(); // Seed data only after connection is successful
  })
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- DATABASE SCHEMAS ---
const userSchema = new mongoose.Schema({
  role: String, name: String, email: String, password: String, phone: String,
  dob: String, nhsNumber: String, gpPractice: String, gpPhone: String, address: String,
  medicalHistory: String, regularMeds: String, painMeds: String,
  staffId: String, department: String, joinedAt: { type: Date, default: Date.now }
});

const reportSchema = new mongoose.Schema({
  patientId: String, patientName: String, patientNHS: String, patientGP: String, patientGpPhone: String,
  patientAddress: String, patientPhone: String, patientDob: String, patientRegularMeds: String, patientPainMeds: String,
  medHistory: String, painLevel: String, medName: String, medTime: String, notes: String,
  status: { type: String, default: 'pending' }, referralType: String, response: String,
  responderName: String, timestamp: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  senderId: String, senderName: String, receiverId: String, message: String, role: String,
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Report = mongoose.model('Report', reportSchema);
const Message = mongoose.model('Message', messageSchema);

// --- SEED DEMO DATA ---
async function seedData() {
  try {
    const userCount = await User.countDocuments();
    if (userCount === 0) {
      console.log('🌱 Seeding demo users...');
      const demoUsers = [
        { role: 'patient', name: 'John Doe', email: 'patient@demo.com', password: '123', nhsNumber: '1234567890', gpPractice: 'City Health Center', medicalHistory: 'Sickle Cell Anemia (HbSS)', regularMeds: 'Hydroxyurea', painMeds: 'Morphine, Ibuprofen', phone: '07700 900000', address: '123 Test Street, London, SW1A 1AA' },
        { role: 'pain-nurse', name: 'Sarah Nurse (Pain Mgmt)', email: 'nurse@demo.com', password: '123', department: 'Pain Management' },
        { role: 'community-nurse', name: 'Mike Nurse (Community)', email: 'community@demo.com', password: '123', department: 'Community Care' },
        { role: 'doctor', name: 'Dr. Smith', email: 'doctor@demo.com', password: '123', department: 'Hematology' }
      ];
      await User.insertMany(demoUsers);
      
      // Create a sample report so the nurse dashboard isn't empty
      const patient = await User.findOne({ role: 'patient' });
      if(patient) {
        await Report.create({
          patientId: patient._id,
          patientName: patient.name,
          patientNHS: patient.nhsNumber,
          patientGP: patient.gpPractice,
          patientGpPhone: patient.gpPhone || '',
          patientAddress: patient.address || '',
          patientPhone: patient.phone || '',
          patientDob: patient.dob || '1990-01-01',
          patientRegularMeds: patient.regularMeds,
          patientPainMeds: patient.painMeds,
          medHistory: patient.medicalHistory,
          painLevel: '8',
          medName: 'Paracetamol',
          medTime: '10:00',
          notes: 'Severe pain in legs',
          status: 'pending'
        });
        console.log('📝 Created sample pain report.');
      }
    } else {
      console.log('ℹ️ Users already exist, skipping seed.');
    }
  } catch (err) {
    console.error('Error seeding data:', err);
  }
}

// --- HTTP ROUTES ---

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { role, email, password, name, ...details } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return res.json({ success: false, message: 'Email already registered' });

    const newUser = await User.create({ role, email, password, name, ...details });
    res.json({ success: true, user: { id: newUser._id, name: newUser.name, role: newUser.role } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    const user = await User.findOne({ email, password, role });
    if (user) {
      const { password, ...safeUser } = user.toObject();
      res.json({ success: true, user: { ...safeUser, id: user._id } });
    } else {
      res.json({ success: false, message: 'Invalid credentials or role' });
    }
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Submit Pain Report
app.post('/api/submit-report', async (req, res) => {
  try {
    const { patientId, painLevel, medName, medTime, notes } = req.body;
    const patient = await User.findById(patientId);
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found' });

    const newReport = await Report.create({
      patientId,
      patientName: patient.name,
      patientNHS: patient.nhsNumber || 'N/A',
      patientGP: patient.gpPractice || 'N/A',
      patientGpPhone: patient.gpPhone || '',
      patientAddress: patient.address || '',
      patientPhone: patient.phone || '',
      patientDob: patient.dob || '',
      patientRegularMeds: patient.regularMeds || '',
      patientPainMeds: patient.painMeds || '',
      medHistory: patient.medicalHistory || 'None',
      painLevel, medName, medTime, notes
    });

    io.emit('report-updated');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Get Patient Reports
app.get('/api/patient-reports/:id', async (req, res) => {
  try {
    const reports = await Report.find({ patientId: req.params.id }).sort({ timestamp: -1 });
    res.json(reports);
  } catch (err) { res.status(500).json([]); }
});

// Get All Reports
app.get('/api/all-reports', async (req, res) => {
  try {
    const reports = await Report.find().sort({ timestamp: -1 });
    res.json(reports);
  } catch (err) { res.status(500).json([]); }
});

// Send Response (FIXED: Handles MongoDB ObjectID correctly)
app.post('/api/send-response', async (req, res) => {
  try {
    const { reportId, nurseId, nurseName, message, referralType } = req.body;
    
    if (!reportId) {
      return res.status(400).json({ success: false, message: 'Report ID is missing' });
    }

    // Use findById which handles ObjectID conversion automatically
    const report = await Report.findById(reportId);
    
    if (!report) {
      console.error('Report not found for ID:', reportId);
      return res.status(404).json({ success: false, message: 'Report not found' });
    }

    report.status = 'responded';
    report.response = message;
    report.responderName = nurseName;
    if (referralType) report.referralType = referralType;
    
    await report.save();
    
    io.emit('report-updated');
    res.json({ success: true });
  } catch (err) { 
    console.error('Error sending response:', err);
    res.status(500).json({ success: false, message: err.message }); 
  }
});

// Chat: Send Message
app.post('/api/send-message', async (req, res) => {
  try {
    const { senderId, senderName, receiverId, message, role } = req.body;
    await Message.create({ senderId, senderName, receiverId, message, role });
    io.emit('new-message');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Chat: Get Messages
app.get('/api/get-messages', async (req, res) => {
  try {
    const messages = await Message.find().sort({ timestamp: 1 }).limit(50);
    res.json(messages);
  } catch (err) { res.status(500).json([]); }
});

// AI: Generate Report
app.post('/api/generate-ai-report', async (req, res) => {
  try {
    const { period } = req.body;
    const now = new Date();
    const cutoff = new Date();
    if (period === 'weekly') cutoff.setDate(now.getDate() - 7);
    if (period === 'monthly') cutoff.setMonth(now.getMonth() - 1);
    if (period === 'yearly') cutoff.setFullYear(now.getFullYear() - 1);

    const reports = await Report.find({ timestamp: { $gt: cutoff } });
    if (reports.length === 0) return res.json({ success: true, report: "No data available." });

    const dataSummary = {
      totalPatientsTreated: new Set(reports.map(r => r.patientId)).size,
      totalReports: reports.length,
      avgPainLevel: (reports.reduce((sum, r) => sum + parseInt(r.painLevel), 0) / reports.length).toFixed(1),
      commonMeds: reports.map(r => r.medName).reduce((acc, curr) => { acc[curr] = (acc[curr] || 0) + 1; return acc; }, {}),
      referrals: reports.filter(r => r.referralType).length
    };

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a healthcare data analyst. Summarize this Sickle Cell clinic data." },
        { role: "user", content: `Period: ${period}. Data: ${JSON.stringify(dataSummary)}. Provide: 1. Executive Summary, 2. Pain Trends, 3. Medication Analysis, 4. Referrals.` }
      ]
    });

    res.json({ success: true, report: completion.choices[0].message.content });
  } catch (error) {
    console.error("AI Error:", error);
    res.json({ success: false, message: "AI Service Unavailable." });
  }
});

// --- SOCKET.IO SETUP ---
const server = http.createServer(app);
const io = socketIo(server);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected'));
});

// Start Server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});