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
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err.message));

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
  const count = await User.countDocuments();
  if (count === 0) {
    const demoUsers = [
      { role: 'patient', name: 'John Doe', email: 'patient@demo.com', password: '123', nhsNumber: '1234567890', gpPractice: 'City Health Center', medicalHistory: 'Sickle Cell Anemia (HbSS)', regularMeds: 'Hydroxyurea', painMeds: 'Morphine, Ibuprofen' },
      { role: 'pain-nurse', name: 'Sarah Nurse (Pain Mgmt)', email: 'nurse@demo.com', password: '123', department: 'Pain Management' },
      { role: 'community-nurse', name: 'Mike Nurse (Community)', email: 'community@demo.com', password: '123', department: 'Community Care' },
      { role: 'doctor', name: 'Dr. Smith', email: 'doctor@demo.com', password: '123', department: 'Hematology' }
    ];
    await User.insertMany(demoUsers);
    console.log('🌱 Demo users seeded.');
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
  } catch (err) { 
    console.error("Register Error:", err);
    res.status(500).json({ success: false, message: err.message }); 
  }
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

// Send Response (FIXED)
app.post('/api/send-response', async (req, res) => {
  try {
    const { reportId, nurseId, nurseName, message, referralType } = req.body;
    
    if (!reportId) return res.status(400).json({ success: false, message: 'Missing Report ID' });

    const updatedReport = await Report.findByIdAndUpdate(
      reportId, 
      { 
        status: 'responded', 
        response: message, 
        responderName: nurseName, 
        referralType: referralType || null 
      },
      { new: true } // Return the updated document
    );

    if (!updatedReport) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }

    console.log(`✅ Response saved for Report ${reportId}`);
    io.emit('report-updated');
    res.json({ success: true });
  } catch (err) { 
    console.error("Response Error:", err);
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

// AI: Generate Report with Data for Charts
app.post('/api/generate-ai-report', async (req, res) => {
  try {
    const { period } = req.body;
    const now = new Date();
    const cutoff = new Date();
    if (period === 'weekly') cutoff.setDate(now.getDate() - 7);
    if (period === 'monthly') cutoff.setMonth(now.getMonth() - 1);
    if (period === 'yearly') cutoff.setFullYear(now.getFullYear() - 1);

    const reports = await Report.find({ timestamp: { $gt: cutoff } });
    
    if (reports.length === 0) {
      return res.json({ 
        success: true, 
        report: "No data available for this period.",
        chartData: null 
      });
    }

    // Prepare Data for Charts
    const painLevels = reports.map(r => parseInt(r.painLevel));
    const avgPain = (painLevels.reduce((a, b) => a + b, 0) / painLevels.length).toFixed(1);
    
    // Count pain levels for bar chart
    const painDistribution = Array(11).fill(0);
    painLevels.forEach(l => painDistribution[l]++);

    // Count medications
    const medCounts = {};
    reports.forEach(r => {
      const med = r.medName || 'Unknown';
      medCounts[med] = (medCounts[med] || 0) + 1;
    });

    const dataSummary = {
      totalPatients: new Set(reports.map(r => r.patientId)).size,
      totalReports: reports.length,
      avgPain: avgPain,
      referrals: reports.filter(r => r.referralType).length
    };

    // Get AI Text Analysis
    let aiText = "Analyzing data...";
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are a healthcare analyst. Provide a brief 3-sentence summary of this Sickle Cell data." },
          { role: "user", content: `Total Reports: ${dataSummary.totalReports}, Avg Pain: ${dataSummary.avgPain}, Referrals: ${dataSummary.referrals}. Summary:` }
        ]
      });
      aiText = completion.choices[0].message.content;
    } catch (aiErr) {
      aiText = "AI Analysis unavailable, but charts are generated below.";
    }

    res.json({ 
      success: true, 
      report: aiText,
      chartData: {
        labels: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
        painData: painDistribution,
        medLabels: Object.keys(medCounts),
        medData: Object.values(medCounts),
        stats: dataSummary
      }
    });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ success: false, message: "Server Error" });
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
  seedData();
});