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
// 🚀 UPGRADE 1: Native Clustering imports
const cluster = require('cluster');
const os = require('os');

const PORT = process.env.PORT || 5000;

// 🚀 UPGRADE 1: Master Process spins up Workers (1 per CPU core)
if (cluster.isPrimary) {
    // Caps workers to 1 on Render's free tier to prevent Out of Memory crashes
    const numCPUs = process.env.WEB_CONCURRENCY || 1;
    console.log(`🚀 Master process ${process.pid} is running`);
    console.log(`🚀 Forking ${numCPUs} worker processes to utilize all CPU cores...`);

    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`⚠️ Worker ${worker.process.pid} died. Spinning up a new one...`);
        cluster.fork(); // Auto-restart crashed workers
    });
} else {
    // ==========================================
    // WORKER PROCESS: RUNS THE EXPRESS APP
    // ==========================================
    const app = express();
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
        rawTrainData.forEach(train => {
            if (train.errorMessage) return;
            try {
                const stations = JSON.parse(train.stationList.replace(/'/g, '"'));
                localTrains.push({ trainNumber: train.trainNumber, trainName: train.trainName, route: stations });
                stations.forEach(stn => localStationsMap.set(stn.stationCode, { name: stn.stationName, code: stn.stationCode }));
            } catch (e) {}
        });
        if (cluster.worker.id === 1) console.log(`✅ ROUTING ENGINE READY: ${localTrains.length} trains loaded.`);
    } catch (e) {
        console.log("⚠️ traininfo.json missing! Offline routing disabled.");
    }
    const localStations = Array.from(localStationsMap.values());

    // ==========================================
    // 3. MONGODB CONNECTION, SCHEMAS & INDEXING
    // ==========================================
    mongoose.connect(process.env.MONGO_URI)
        .then(() => { if(cluster.worker.id === 1) console.log('✅ Connected to MongoDB Database!') })
        .catch((err) => console.error('❌ MongoDB Connection Error:', err.message));

    const userSchema = new mongoose.Schema({
        name: { type: String, required: true }, 
        email: { type: String, required: true, unique: true },
        password: { type: String, required: true }, 
        createdAt: { type: Date, default: Date.now }
    });
    // 🚀 UPGRADE 2: MongoDB Indexing
    userSchema.index({ email: 1 });
    const User = mongoose.model('User', userSchema);

    const ticketSchema = new mongoose.Schema({
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
    });
    // 🚀 UPGRADE 2: MongoDB Indexing for faster history & cancellation
    ticketSchema.index({ pnr: 1, userId: 1 });
    ticketSchema.index({ trainNumber: 1, date: 1, status: 1 });
    const Ticket = mongoose.model('Ticket', ticketSchema);

    const fareSchema = new mongoose.Schema({
        trainNumber: String, fromStnCode: String, toStnCode: String,
        classCode: String, totalFare: Number, distance: Number
    });
    // 🚀 UPGRADE 2: MongoDB Indexing for O(1) Fare Searches
    fareSchema.index({ fromStnCode: 1, toStnCode: 1, trainNumber: 1 });
    const Fare = mongoose.model('Fare', fareSchema);

    const seatInventorySchema = new mongoose.Schema({
        trainNumber: String, date: String,
        totalSeats: { type: Number, default: 120 },    
        bookedSeats: { type: Number, default: 0 },
        waitlistCount: { type: Number, default: 0 },
        maxWaitlist: { type: Number, default: 20 }
    });
    // 🚀 UPGRADE 2: Compound Index for the Atomic Booking Lock
    seatInventorySchema.index({ trainNumber: 1, date: 1, bookedSeats: 1 });
    const SeatInventory = mongoose.model('SeatInventory', seatInventorySchema);

    const seatSchema = new mongoose.Schema({
        trainNumber: String, date: String, coach: String, seatNumber: Number,
        isBooked: { type: Boolean, default: false },
        ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null }
    });
    // 🚀 UPGRADE 2: Index for physical seat assignment
    seatSchema.index({ trainNumber: 1, date: 1, isBooked: 1 });
    const Seat = mongoose.model('Seat', seatSchema);

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

    // 🚀 UPGRADE 3: In-Memory Search Caching Map
    const searchCache = new Map();

    app.get('/searchTrains', async (req, res) => {
        const source = req.query.source?.trim().toUpperCase();
        const destination = req.query.destination?.trim().toUpperCase();
        const date = req.query.date?.trim();

        if (!source || !destination || !date) return res.status(400).json({ error: "Missing fields." });
        
        // 🚀 UPGRADE 3: Check cache before hitting the database
        const cacheKey = `${source}-${destination}-${date}`;
        if (searchCache.has(cacheKey)) {
            const cachedData = searchCache.get(cacheKey);
            if (cachedData.expiry > Date.now()) {
                return res.json(cachedData.data); // Serve from RAM instantly
            } else {
                searchCache.delete(cacheKey); // Expired
            }
        }

        let matchingTrains = [];
        let matchingTrainNumbers = []; 

        localTrains.forEach(train => {
            const sourceIndex = train.route.findIndex(s => s.stationCode === source);
            const destIndex = train.route.findIndex(s => s.stationCode === destination);

            if (sourceIndex !== -1 && destIndex !== -1 && sourceIndex < destIndex) {
                matchingTrains.push({
                    trainNumber: train.trainNumber, trainName: train.trainName,
                    departureTime: train.route[sourceIndex].departureTime, arrivalTime: train.route[destIndex].arrivalTime,
                    availability: "CHECKING...", price: 150 + ((destIndex - sourceIndex) * 65)
                });
                matchingTrainNumbers.push(train.trainNumber);
            }
        });

        if (matchingTrains.length === 0) return res.json([]);

        try {
            const [realFares, inventories] = await Promise.all([
                Fare.find({ fromStnCode: source, toStnCode: destination, trainNumber: { $in: matchingTrainNumbers } }).lean(),
                SeatInventory.find({ date: date, trainNumber: { $in: matchingTrainNumbers } }).lean()
            ]);

            for (let train of matchingTrains) {
                const exactFare = realFares.find(f => f.trainNumber === train.trainNumber);
                if (exactFare) train.price = exactFare.totalFare;

                let inventory = inventories.find(inv => inv.trainNumber === train.trainNumber);
                const total = inventory ? inventory.totalSeats : 120;
                const booked = inventory ? inventory.bookedSeats : 0;
                const wlCount = inventory ? inventory.waitlistCount : 0;
                const maxWl = inventory ? inventory.maxWaitlist : 20;

                const available = total - booked;
                if (available > 0) train.availability = `AVL ${available}`;
                else if (wlCount < maxWl) train.availability = `WL ${wlCount + 1}`; 
                else train.availability = "REGRET"; 
            }

            // 🚀 UPGRADE 3: Save results to cache for 60 seconds
            searchCache.set(cacheKey, { data: matchingTrains, expiry: Date.now() + 60000 });

            res.json(matchingTrains);
        } catch (error) {
            res.status(500).json({ error: "Search optimization failed" }); 
        }
    });

    app.get('/liveStatus', async (req, res) => {
        const trainNumber = req.query.trainNumber?.trim(); 
        const date = req.query.date?.trim(); 
        if (!trainNumber || !date) return res.status(400).json({ error: "Missing parameters" });
        try {
            const targetHost = 'indian-railway-irctc.p.rapidapi.com';
            const url = `https://${targetHost}/api/trains/v1/train/status`;
            const response = await axios.get(url, {
                params: { train_number: trainNumber, departure_date: date, isH5: 'true', client: 'web', deviceIdentifier: 'Mozilla Firefox' },
                headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': targetHost }
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
            const response = await axios.get(`https://irctc1.p.rapidapi.com/api/v3/getPNRStatus`, {
                params: { pnrNumber: pnrNumber },
                headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'irctc1.p.rapidapi.com' }
            });
            if (response.data?.data) res.json(response.data.data);
            else res.status(404).json({ error: "PNR not found." });
        } catch (error) { res.status(500).json({ error: "Failed to fetch PNR status." }); }
    });

    // ==========================================
    // 5. THE "20 LPA" ATOMIC BOOKING ENGINE
    // ==========================================
    app.post('/api/bookings', verifyToken, async (req, res) => {
        const idempotencyKey = req.headers['x-idempotency-key'];
        if (idempotencyKey) {
            const existingTicket = await Ticket.findOne({ idempotencyKey, userId: req.userId }).lean();
            if (existingTicket) return res.status(200).json({ message: "Booking already processed", ticket: existingTicket });
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { trainNumber, trainName, source, destination, date, passengers, totalPrice } = req.body;
            const count = passengers.length;

            let inventoryCheck = await SeatInventory.findOne({ trainNumber, date }).session(session);
            if (!inventoryCheck) {
                const newSeats = [];
                const coaches = ['S1', 'S2']; 
                coaches.forEach(coach => {
                    for(let i=1; i<=60; i++) newSeats.push({ trainNumber, date, coach, seatNumber: i });
                });
                await Seat.insertMany(newSeats, { session });
                await SeatInventory.create([{ trainNumber, date, totalSeats: 120, bookedSeats: 0, waitlistCount: 0, maxWaitlist: 20 }], { session });
            }

            let finalStatus = "CONFIRMED";
            let startingWlPosition = null;

            let inventory = await SeatInventory.findOneAndUpdate(
                { trainNumber, date, bookedSeats: { $lte: 120 - count } }, 
                { $inc: { bookedSeats: count } },
                { new: true, session }
            );

            if (!inventory) {
                inventory = await SeatInventory.findOneAndUpdate(
                    { trainNumber, date, waitlistCount: { $lte: 20 - count } },
                    { $inc: { waitlistCount: count } },
                    { new: true, session }
                );
                
                if (!inventory) {
                    await session.abortTransaction();
                    session.endSession();
                    return res.status(400).json({ error: "REGRET: Train and Waitlist are completely full." });
                }
                finalStatus = "WAITLIST";
                startingWlPosition = (inventory.waitlistCount - count) + 1; 
            }

            let allocatedSeats = [];
            if (finalStatus === "CONFIRMED") {
                allocatedSeats = await Seat.find({ trainNumber, date, isBooked: false }).limit(count).session(session);
                if (allocatedSeats.length !== count) throw new Error("Database physical seat desync");
                const seatIds = allocatedSeats.map(s => s._id);
                await Seat.updateMany({ _id: { $in: seatIds } }, { $set: { isBooked: true } }, { session });
            }

            const generatedPnr = crypto.randomBytes(5).toString('hex').toUpperCase();
            let currentWlCounter = startingWlPosition;

            const detailedPassengers = passengers.map((p, index) => {
                let pSeat = "WAITLIST";
                let pWlPos = null;
                if (finalStatus === "CONFIRMED") {
                    pSeat = `${allocatedSeats[index].coach} - ${allocatedSeats[index].seatNumber}`;
                } else {
                    pWlPos = currentWlCounter++; 
                    pSeat = `WL ${pWlPos}`;
                }
                return { ...p, seatNumber: pSeat, wlPosition: pWlPos };
            });

            const [newTicket] = await Ticket.create([{ 
                userId: req.userId, trainNumber, trainName, source, destination, date, 
                passengers: detailedPassengers, totalPrice, pnr: generatedPnr, 
                status: finalStatus, idempotencyKey: idempotencyKey || null
            }], { session });

            if (finalStatus === "CONFIRMED") {
                const seatIds = allocatedSeats.map(s => s._id);
                await Seat.updateMany({ _id: { $in: seatIds } }, { $set: { ticketId: newTicket._id } }, { session });
            }
            
            // 🚀 UPGRADE 3: Invalidate cache for this route so availability updates immediately
            searchCache.delete(`${source}-${destination}-${date}`);

            await session.commitTransaction();
            session.endSession();
            res.status(201).json({ message: "Booked!", pnr: generatedPnr, status: finalStatus, ticket: newTicket });
        } catch (error) { 
            await session.abortTransaction();
            session.endSession();
            res.status(500).json({ error: "Booking Failed due to server load." }); 
        }
    });

    // ==========================================
    // 6. PASSENGER-LEVEL WAITLIST SHIFTING ENGINE
    // ==========================================
    app.delete('/cancelTicket/:pnr', verifyToken, async (req, res) => {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { pnr } = req.params;
            const ticket = await Ticket.findOne({ pnr, userId: req.userId }).session(session);
            if (!ticket) throw new Error("Ticket not found or unauthorized.");
            if (ticket.status === "CANCELLED") throw new Error("Ticket is already cancelled.");

            const canceledCount = ticket.passengers.length;
            const wasConfirmed = ticket.status === "CONFIRMED";
            ticket.status = "CANCELLED";
            await ticket.save({ session });

            const inventory = await SeatInventory.findOne({ trainNumber: ticket.trainNumber, date: ticket.date }).session(session);

            if (wasConfirmed) {
                await Seat.updateMany({ ticketId: ticket._id }, { $set: { isBooked: false, ticketId: null } }, { session });
                inventory.bookedSeats -= canceledCount;

                let freedSeats = await Seat.find({ trainNumber: ticket.trainNumber, date: ticket.date, isBooked: false }).session(session);
                const wlTickets = await Ticket.find({ trainNumber: ticket.trainNumber, date: ticket.date, status: "WAITLIST" }).session(session);
                
                let wlQueue = [];
                wlTickets.forEach(t => {
                    t.passengers.forEach(p => {
                        if (p.wlPosition !== null) wlQueue.push({ ticket: t, passenger: p });
                    });
                });

                wlQueue.sort((a, b) => a.passenger.wlPosition - b.passenger.wlPosition);

                let upgrades = 0;
                for (let i = 0; i < wlQueue.length; i++) {
                    let item = wlQueue[i];
                    if (freedSeats.length > 0) {
                        let seat = freedSeats.shift();
                        item.passenger.seatNumber = `${seat.coach} - ${seat.seatNumber}`;
                        item.passenger.wlPosition = null;
                        seat.isBooked = true;
                        seat.ticketId = item.ticket._id;
                        await seat.save({ session });
                        upgrades++;
                    } else {
                        item.passenger.wlPosition = i - upgrades + 1;
                        item.passenger.seatNumber = `WL ${item.passenger.wlPosition}`;
                    }
                }

                for (let t of wlTickets) {
                    let allConfirmed = t.passengers.every(p => p.wlPosition === null);
                    if (allConfirmed) t.status = "CONFIRMED";
                    await t.save({ session });
                }

                inventory.bookedSeats += upgrades;
                inventory.waitlistCount -= upgrades;

            } else {
                inventory.waitlistCount -= canceledCount;
            }

            await inventory.save({ session });
            
            // 🚀 UPGRADE 3: Invalidate cache so availability updates immediately
            searchCache.delete(`${ticket.source}-${ticket.destination}-${ticket.date}`);

            await session.commitTransaction();
            session.endSession();

            res.status(200).json({ message: "Cancelled.", refundAmount: ticket.totalPrice * 0.80, status: "CANCELLED" });
        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            res.status(400).json({ error: error.message || "Cancellation failed." });
        }
    });

    // ==========================================
    // 7. USER MANAGEMENT & AUTH
    // ==========================================
    app.get('/myTickets', verifyToken, async (req, res) => {
        try {
            const tickets = await Ticket.find({ userId: req.userId }).sort({ bookingDate: -1 }).lean();
            res.json(tickets);
        } catch (error) { res.status(500).json({ error: "Failed to fetch tickets." }); }
    });

    const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    app.post('/register', async (req, res) => {
        try {
            const { name, email, password } = req.body;
            if (await User.findOne({ email }).lean()) return res.status(400).json({ error: "Email exists." });
            const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));
            await new User({ name, email, password: hashedPassword }).save();
            res.status(201).json({ message: "Success." });
        } catch (e) { res.status(500).json({ error: "Internal Error." }); }
    });

    app.post('/login', async (req, res) => {
        try {
            const { email, password } = req.body;
            const user = await User.findOne({ email }).lean();
            if (user && await bcrypt.compare(password, user.password)) {
                const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
                res.json({ token, user: { name: user.name, email: user.email } });
            } else { res.status(401).json({ error: "Invalid credentials." }); }
        } catch (e) { res.status(500).json({ error: "Internal Error." }); }
    });

    app.post('/auth/google', async (req, res) => {
        try {
            const ticket = await googleClient.verifyIdToken({ idToken: req.body.idToken, audience: process.env.GOOGLE_CLIENT_ID });
            const { email, name } = ticket.getPayload();
            let user = await User.findOne({ email }).lean();
            if (!user) {
                const hashedPassword = await bcrypt.hash(Math.random().toString(36), 10);
                user = await new User({ name, email, password: hashedPassword }).save();
            }
            const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
            res.json({ token, user: { name: user.name, email: user.email } });
        } catch (e) { res.status(401).json({ error: "Google Auth Failed." }); }
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚂 Worker ${process.pid} listening on port ${PORT}`);
    });
}
