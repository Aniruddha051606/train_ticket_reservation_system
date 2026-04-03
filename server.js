require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 5000;
app.set('trust proxy', 1);

// ==========================================
// 1. MIDDLEWARE & SECURITY
// ==========================================
app.use(helmet()); 
app.use(cors());
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/pnr', limiter);
app.use('/liveStatus', limiter);

// ==========================================
// 2. LOAD LOCAL TRAIN DATABASE
// ==========================================
let localTrains = [];
let localStationsMap = new Map();

try {
    const rawTrainData = require('./traininfo.json');
    console.log("⏳ Parsing local train routes...");
    rawTrainData.forEach(train => {
        if (train.errorMessage) return;
        try {
            const stations = JSON.parse(train.stationList.replace(/'/g, '"'));
            localTrains.push({ trainNumber: train.trainNumber, trainName: train.trainName, route: stations });
            stations.forEach(stn => localStationsMap.set(stn.stationCode, { name: stn.stationName, code: stn.stationCode }));
        } catch (e) {}
    });
    console.log(`✅ ROUTING ENGINE READY: ${localTrains.length} trains & ${localStationsMap.size} stations loaded.`);
} catch (e) {
    console.log("⚠️ traininfo.json missing! Offline routing disabled.");
}
const localStations = Array.from(localStationsMap.values());

// ==========================================
// 3. MONGODB CONNECTION & SCHEMAS
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Database!'))
    .catch((err) => console.error('❌ MongoDB Connection Error:', err.message));

const User = mongoose.model('User', new mongoose.Schema({
    name: { type: String, required: true }, 
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }, 
    createdAt: { type: Date, default: Date.now }
}));

// 🌟 UPGRADED TICKET SCHEMA
const Ticket = mongoose.model('Ticket', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    trainNumber: String, trainName: String, source: String, destination: String,
    date: String, 
    passengers: [{
        name: String, age: Number, gender: String, seatNumber: String,
        wlPosition: { type: Number, default: null } 
    }],
    totalPrice: Number, pnr: { type: String, unique: true },
    status: { type: String, default: 'CONFIRMED' },
    bookingDate: { type: Date, default: Date.now },
    idempotencyKey: { type: String, unique: true, sparse: true } 
}));

const Fare = mongoose.model('Fare', new mongoose.Schema({
    trainNumber: String, fromStnCode: String, toStnCode: String,
    classCode: String, totalFare: Number, distance: Number
}));

// 🌟 UPGRADED INVENTORY SCHEMA
const SeatInventory = mongoose.model('SeatInventory', new mongoose.Schema({
    trainNumber: String,
    date: String,
    totalSeats: { type: Number, default: 120 },    
    bookedSeats: { type: Number, default: 0 },
    waitlistCount: { type: Number, default: 0 },
    maxWaitlist: { type: Number, default: 20 }
}));

const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1] || req.headers['authorization'];
    if (!token) return res.status(403).json({ error: "Access Denied." });
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: "Session expired." });
        req.userId = decoded.userId;
        next();
    });
};

// ==========================================
// 4. CORE RAILWAY ROUTES
// ==========================================
app.get('/searchStation', (req, res) => {
    const searchQuery = req.query.searchQuery?.trim().toLowerCase();
    if (!searchQuery || searchQuery.length < 2) return res.json([]);

    const matches = localStations.filter(station => 
        station.name.toLowerCase().includes(searchQuery) || station.code.toLowerCase().includes(searchQuery)
    );
    res.json(matches.slice(0, 10));
});

app.get('/searchTrains', async (req, res) => {
    const source = req.query.source?.trim().toUpperCase();
    const destination = req.query.destination?.trim().toUpperCase();
    const date = req.query.date?.trim();

    if (!source || !destination || !date) return res.status(400).json({ error: "Missing fields." });
    
    let matchingTrains = [];

    localTrains.forEach(train => {
        const sourceIndex = train.route.findIndex(s => s.stationCode === source);
        const destIndex = train.route.findIndex(s => s.stationCode === destination);

        if (sourceIndex !== -1 && destIndex !== -1 && sourceIndex < destIndex) {
            const numberOfStops = destIndex - sourceIndex;
            const dynamicPrice = 150 + (numberOfStops * 65); 

            matchingTrains.push({
                trainNumber: train.trainNumber, trainName: train.trainName,
                departureTime: train.route[sourceIndex].departureTime, arrivalTime: train.route[destIndex].arrivalTime,
                availability: "CHECKING...", price: dynamicPrice 
            });
        }
    });

    if (matchingTrains.length === 0) return res.json([]);

    try {
        const realFares = await Fare.find({ fromStnCode: source, toStnCode: destination, classCode: 'SL' });
        
        for (let i = 0; i < matchingTrains.length; i++) {
            let train = matchingTrains[i];
            const exactFare = realFares.find(f => f.trainNumber === train.trainNumber);
            train.price = exactFare ? exactFare.totalFare : train.price;

            let inventory = await SeatInventory.findOne({ trainNumber: train.trainNumber, date: date });

            if (!inventory) {
                inventory = await SeatInventory.create({ trainNumber: train.trainNumber, date: date });
            }

            let statusText = "";
            const available = inventory.totalSeats - inventory.bookedSeats;

            if (available > 0) statusText = `AVL ${available}`;
            else if (inventory.waitlistCount < inventory.maxWaitlist) statusText = `WL ${inventory.waitlistCount + 1}`; 
            else statusText = "REGRET"; 

            train.availability = statusText;
        }

        res.json(matchingTrains);
    } catch (error) {
        console.error("Search Error:", error);
        res.json(matchingTrains); 
    }
});

app.get('/liveStatus', async (req, res) => {
    const trainNumber = req.query.trainNumber?.trim(); 
    const date = req.query.date?.trim(); 
    if (!trainNumber || !date) return res.status(400).json({ error: "Missing trainNumber or date" });

    try {
        const targetHost = 'indian-railway-irctc.p.rapidapi.com';
        const url = `https://${targetHost}/api/trains/v1/train/status`;
        const response = await axios.get(url, {
            params: { train_number: trainNumber, departure_date: date, isH5: 'true', client: 'web', deviceIdentifier: 'Mozilla Firefox-138.0.0.0' },
            headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': targetHost, 'x-rapid-api': 'rapid-api-database' }
        });
        res.json(response.data);
    } catch (error) {
        res.json({ status: "Running (Mock)", currentStation: "Mock Station", delay: "On Time", lastUpdated: new Date().toISOString() });
    }
});

app.get('/pnr', async (req, res) => {
    const pnrNumber = req.query.pnrNumber?.trim();
    if (!pnrNumber || pnrNumber.length !== 10) return res.status(400).json({ error: "Invalid PNR." });

    try {
        const url = `https://irctc1.p.rapidapi.com/api/v3/getPNRStatus`;
        const response = await axios.get(url, {
            params: { pnrNumber: pnrNumber },
            headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'irctc1.p.rapidapi.com' }
        });
        if (response.data?.data) res.json(response.data.data);
        else res.status(404).json({ error: "PNR details not found." });
    } catch (error) { 
        res.status(500).json({ error: "Failed to fetch PNR status." }); 
    }
});

// ==========================================
// 5. ADVANCED BOOKING ENGINE (FAANG LEVEL)
// ==========================================
app.post('/api/bookings', verifyToken, async (req, res) => {
    const idempotencyKey = req.headers['x-idempotency-key'];
    if (idempotencyKey) {
        const existingTicket = await Ticket.findOne({ idempotencyKey, userId: req.userId });
        if (existingTicket) return res.status(200).json({ message: "Booking already processed", ticket: existingTicket });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { trainNumber, trainName, source, destination, date, passengers, totalPrice } = req.body;
        const count = passengers.length;

        const inventory = await SeatInventory.findOne({ trainNumber, date }).session(session);
        if (!inventory) throw new Error("Train inventory not found for this date.");

        let finalStatus = "CONFIRMED";
        let startingWlPosition = null;

        if (inventory.bookedSeats + count <= inventory.totalSeats) {
            inventory.bookedSeats += count;
        } else if (inventory.waitlistCount + count <= inventory.maxWaitlist) {
            finalStatus = "WAITLIST";
            startingWlPosition = inventory.waitlistCount + 1;
            inventory.waitlistCount += count;
        } else {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ error: "REGRET: Train and Waitlist are completely full." });
        }

        await inventory.save({ session });

        const generatedPnr = crypto.randomBytes(5).toString('hex').toUpperCase();
        const coachTypes = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
        
        let currentWlCounter = startingWlPosition;

        const detailedPassengers = passengers.map(p => {
            let pSeat = "WAITLIST";
            let pWlPos = null;

            if (finalStatus === "CONFIRMED") {
                pSeat = `${coachTypes[Math.floor(Math.random() * coachTypes.length)]} - ${Math.floor(Math.random() * 72) + 1}`;
            } else {
                pWlPos = currentWlCounter++; 
                pSeat = `WL ${pWlPos}`;
            }
            return { ...p, seatNumber: pSeat, wlPosition: pWlPos };
        });

        const [newTicket] = await Ticket.create([{ 
            userId: req.userId, 
            trainNumber, trainName, source, destination, date, 
            passengers: detailedPassengers, totalPrice, 
            pnr: generatedPnr, 
            status: finalStatus,
            idempotencyKey: idempotencyKey || null
        }], { session });

        await session.commitTransaction();
        session.endSession();

        res.status(201).json({ message: "Booked Successfully!", pnr: generatedPnr, status: finalStatus, ticket: newTicket });
    } catch (error) { 
        await session.abortTransaction();
        session.endSession();
        console.error("Booking Transaction Error:", error);
        res.status(500).json({ error: "Booking Failed due to server load." }); 
    }
});

// ==========================================
// 6. SMART CANCELLATION & WAITLIST UPGRADE
// ==========================================
app.delete('/cancelTicket/:pnr', verifyToken, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { pnr } = req.params;

        const ticket = await Ticket.findOne({ pnr, userId: req.userId }).session(session);
        if (!ticket) throw new Error("Ticket not found or unauthorized.");
        if (ticket.status === "CANCELLED") throw new Error("Ticket is already cancelled.");

        const canceledSeatCount = ticket.passengers.length;
        const wasConfirmed = ticket.status === "CONFIRMED";

        const refundAmount = ticket.totalPrice * 0.80;
        ticket.status = "CANCELLED";
        await ticket.save({ session });

        const inventory = await SeatInventory.findOne({ trainNumber: ticket.trainNumber, date: ticket.date }).session(session);
        
        if (wasConfirmed) {
            inventory.bookedSeats -= canceledSeatCount;
            
            // 🚀 AUTO-UPGRADE WAITLIST QUEUE
            const waitlistedTickets = await Ticket.find({
                trainNumber: ticket.trainNumber, date: ticket.date, status: "WAITLIST"
            }).sort({ bookingDate: 1 }).session(session);

            let availableFreedSeats = canceledSeatCount;

            for (let wlTicket of waitlistedTickets) {
                if (availableFreedSeats <= 0) break; 
                
                if (wlTicket.passengers.length <= availableFreedSeats) {
                    wlTicket.status = "CONFIRMED";
                    wlTicket.passengers.forEach(p => {
                        p.seatNumber = `UPGRADED-${Math.floor(Math.random() * 99)}`;
                        p.wlPosition = null;
                    });

                    await wlTicket.save({ session });
                    inventory.bookedSeats += wlTicket.passengers.length;
                    inventory.waitlistCount -= wlTicket.passengers.length;
                    availableFreedSeats -= wlTicket.passengers.length;
                }
            }
        } else {
            inventory.waitlistCount -= canceledSeatCount;
        }

        await inventory.save({ session });
        await session.commitTransaction();
        session.endSession();

        res.status(200).json({ message: "Ticket cancelled successfully.", refundAmount: refundAmount, status: "CANCELLED" });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Cancellation Transaction Failed:", error);
        res.status(400).json({ error: error.message || "Cancellation failed." });
    }
});

// ==========================================
// 7. USER MANAGEMENT & AUTHENTICATION
// ==========================================
app.get('/myTickets', verifyToken, async (req, res) => {
    try {
        const tickets = await Ticket.find({ userId: req.userId }).sort({ bookingDate: -1 });
        res.json(tickets);
    } catch (error) { 
        res.status(500).json({ error: "Failed to fetch tickets." }); 
    }
});

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (await User.findOne({ email })) return res.status(400).json({ error: "Email exists." });
        const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));
        await new User({ name, email, password: hashedPassword }).save();
        res.status(201).json({ message: "Success." });
    } catch (e) { 
        console.error("Register Error:", e);
        res.status(500).json({ error: "Internal Error." }); 
    }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (user && await bcrypt.compare(password, user.password)) {
            const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
            res.json({ token, user: { name: user.name, email: user.email } });
        } else { 
            res.status(401).json({ error: "Invalid credentials." }); 
        }
    } catch (e) { 
        console.error("Login Error:", e);
        res.status(500).json({ error: "Internal Error." }); 
    }
});

app.post('/auth/google', async (req, res) => {
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: req.body.idToken, audience: process.env.GOOGLE_CLIENT_ID });
        const { email, name } = ticket.getPayload();
        
        let user = await User.findOne({ email });
        if (!user) {
            const hashedPassword = await bcrypt.hash(Math.random().toString(36), 10);
            user = await new User({ name, email, password: hashedPassword }).save();
        }
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { name: user.name, email: user.email } });
    } catch (e) { 
        console.error("🚨 GOOGLE REJECTED IT:", e.message);
        res.status(401).json({ error: "Google Auth Failed." }); 
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚂 RailConnect API live on port ${PORT}`));