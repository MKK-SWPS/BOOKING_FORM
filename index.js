const express = require('express')
const fs = require('fs').promises
const path = require('path')

const app = express()
const port = 3000

app.use(express.json())
app.use(express.static('public'))

// Try to use Vercel KV if environment variables are set
let kv = null
const useVercelKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
if (useVercelKV) {
  try {
    kv = require('@vercel/kv').kv
    console.log('Using Vercel KV for storage')
  } catch (error) {
    console.log('Vercel KV not available, using file system')
  }
} else {
  console.log('Using file system for local development (set KV_REST_API_URL and KV_REST_API_TOKEN to use Vercel KV)')
}

const BOOKINGS_DIR = path.join(__dirname, 'bookings')
const BOOKINGS_FILE = path.join(BOOKINGS_DIR, 'all-bookings.json')

const ALL_TIME_SLOTS = [
  '09:00',
  '10:00',
  '11:00',
  '12:00',
  '13:00',
  '14:00',
  '15:00',
  '16:00',
  '17:00'
]

const MAX_BOOKING_DAYS = 30

function toDateOnlyString(date) {
  const normalized = new Date(date)
  normalized.setHours(0, 0, 0, 0)
  return normalized.toISOString().split('T')[0]
}

function getDateBounds() {
  const today = new Date()
  const minDate = toDateOnlyString(today)
  const maxDateObj = new Date(today)
  maxDateObj.setDate(maxDateObj.getDate() + MAX_BOOKING_DAYS)
  const maxDate = toDateOnlyString(maxDateObj)
  return { minDate, maxDate }
}

function isValidBookingDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return false
  }

  const parsed = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return false
  }

  const { minDate, maxDate } = getDateBounds()
  return dateStr >= minDate && dateStr <= maxDate
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

async function ensureBookingsFile() {
  try {
    await fs.access(BOOKINGS_FILE)
  } catch (error) {
    await fs.mkdir(BOOKINGS_DIR, { recursive: true })
    await fs.writeFile(BOOKINGS_FILE, '[]', 'utf8')
  }
}

async function loadBookings() {
  // Use Vercel KV if available, otherwise fall back to file system
  if (kv) {
    try {
      const allKeys = await kv.keys('booking:*')
      if (!allKeys || allKeys.length === 0) {
        return []
      }
      
      const bookings = []
      for (const key of allKeys) {
        const booking = await kv.get(key)
        if (booking) {
          bookings.push(booking)
        }
      }
      return bookings
    } catch (error) {
      console.error('Error loading from Vercel KV:', error)
      return []
    }
  }

  // File system fallback for local development
  await ensureBookingsFile()

  const data = await fs.readFile(BOOKINGS_FILE, 'utf8')
  if (!data.trim()) {
    return []
  }

  let bookings
  try {
    bookings = JSON.parse(data)
  } catch (error) {
    console.error('Failed to parse bookings file, resetting to empty array', error)
    bookings = []
  }

  let needsSave = false
  const normalized = bookings.map(booking => {
    if (booking.date) {
      return booking
    }

    if (booking.timestamp) {
      const derivedDate = toDateOnlyString(new Date(booking.timestamp))
      if (derivedDate) {
        needsSave = true
        return { ...booking, date: derivedDate }
      }
    }

    return booking
  })

  if (needsSave) {
    await saveBookings(normalized)
    return normalized
  }

  return bookings
}

async function saveBookings(bookings) {
  // Use Vercel KV if available
  if (kv) {
    try {
      // Save each booking with a unique key
      for (const booking of bookings) {
        await kv.set(`booking:${booking.id}`, booking)
      }
      return
    } catch (error) {
      console.error('Error saving to Vercel KV:', error)
      throw error
    }
  }

  // File system fallback for local development
  await fs.mkdir(BOOKINGS_DIR, { recursive: true })
  await fs.writeFile(BOOKINGS_FILE, `${JSON.stringify(bookings, null, 2)}\n`, 'utf8')
}

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Booking Calendar</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #0f1419;
            min-height: 100vh;
            padding: 20px;
        }
        
        .booking-container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #1a1a1a;
            border-radius: 15px;
            overflow: hidden;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        }
        
        .booking-header {
            background-color: #2d2d2d;
            color: white;
            padding: 20px;
            text-align: center;
            border-bottom: 1px solid #3d3d3d;
        }
        
        .booking-header h1 {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 5px;
        }
        
        .booking-header p {
            color: #999;
            font-size: 14px;
        }
        
        .booking-content {
            padding: 30px;
        }
        
        .form-section {
            margin-bottom: 25px;
        }
        
        .form-section h2 {
            color: #007aff;
            font-size: 18px;
            margin-bottom: 15px;
        }
        
        .form-group {
            margin-bottom: 15px;
        }
        
        .form-group label {
            display: block;
            color: #e5e5e5;
            margin-bottom: 8px;
            font-size: 14px;
            font-weight: 500;
        }
        
        .form-group input,
        .form-group select {
            width: 100%;
            padding: 12px;
            background-color: #2d2d2d;
            border: 1px solid #3d3d3d;
            border-radius: 8px;
            color: white;
            font-size: 14px;
            transition: border-color 0.2s;
        }
        
        .form-group input:focus,
        .form-group select:focus {
            outline: none;
            border-color: #007aff;
        }
        
        .form-group input::placeholder {
            color: #666;
        }
        
        .date-picker-container {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .date-picker-container input[type="date"] {
            padding: 12px;
            background-color: #2d2d2d;
            border: 1px solid #3d3d3d;
            border-radius: 8px;
            color: white;
            font-size: 14px;
        }
        
        .date-picker-container input[type="date"]:focus {
            outline: none;
            border-color: #007aff;
        }
        
        .date-help {
            color: #666;
            font-size: 12px;
        }
        
        .time-slots {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
            gap: 10px;
            margin-top: 15px;
        }
        
        .time-slot {
            padding: 12px;
            background-color: #2d2d2d;
            border: 2px solid #3d3d3d;
            border-radius: 8px;
            color: white;
            cursor: pointer;
            text-align: center;
            transition: all 0.2s;
            font-size: 14px;
            font-weight: 500;
        }
        
        .time-slot:hover:not(.disabled) {
            border-color: #007aff;
            background-color: #1e3a5f;
        }
        
        .time-slot.selected {
            background-color: #007aff;
            border-color: #007aff;
        }
        
        .time-slot.disabled {
            background-color: #1a1a1a;
            border-color: #2a2a2a;
            color: #666;
            cursor: not-allowed;
            text-decoration: line-through;
        }
        
        .submit-button {
            width: 100%;
            padding: 15px;
            background-color: #007aff;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            margin-top: 20px;
        }
        
        .submit-button:hover:not(:disabled) {
            background-color: #0056cc;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0, 122, 255, 0.3);
        }
        
        .submit-button:disabled {
            background-color: #666;
            cursor: not-allowed;
            transform: none;
        }
        
        .message {
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
            animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(-10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .message.success {
            background-color: #10b981;
            color: white;
        }
        
        .message.error {
            background-color: #ff3b30;
            color: white;
        }
        
        .loading {
            text-align: center;
            color: #999;
            padding: 20px;
        }
        
        .required {
            color: #ff3b30;
        }
    </style>
</head>
<body>
    <div class="booking-container">
        <div class="booking-header">
            <h1>📅 Book Your Time Slot</h1>
            <p>Select an available time and fill in your details</p>
        </div>
        
        <div class="booking-content">
            <div id="messageArea"></div>
            
            <form id="bookingForm">
                <div class="form-section">
                    <h2>Select Date</h2>
                    <div class="date-picker-container">
                        <input type="date" id="datePicker" required>
                        <div class="date-help" id="dateHelp"></div>
                    </div>
                </div>
                
                <div class="form-section">
                    <h2>Select Time Slot</h2>
                    <div id="timeSlotsContainer" class="loading">
                        Loading available time slots...
                    </div>
                    <input type="hidden" id="selectedTime" name="timeSlot">
                </div>
                
                <div class="form-section">
                    <h2>Your Information</h2>
                    
                    <div class="form-group">
                        <label for="name">Name <span class="required">*</span></label>
                        <input type="text" id="name" name="name" placeholder="Enter your full name" required>
                    </div>
                    
                    <div class="form-group">
                        <label for="email">Email <span class="required">*</span></label>
                        <input type="email" id="email" name="email" placeholder="your.email@example.com" required>
                    </div>
                    
                    <div class="form-group">
                        <label for="gender">Gender <span class="required">*</span></label>
                        <select id="gender" name="gender" required>
                            <option value="">Select your gender</option>
                            <option value="male">Male</option>
                            <option value="female">Female</option>
                            <option value="non-binary">Non-binary</option>
                            <option value="prefer-not-to-say">Prefer not to say</option>
                        </select>
                    </div>
                    
                    <div class="form-group">
                        <label for="age">Age <span class="required">*</span></label>
                        <input type="number" id="age" name="age" placeholder="Enter your age" min="1" max="120" required>
                    </div>
                </div>
                
                <button type="submit" class="submit-button" id="submitButton">
                    Book Appointment
                </button>
            </form>
        </div>
    </div>

    <script>
        let availableSlots = [];
        let selectedTimeSlot = null;
        let selectedDate = null;

        function formatDateForDisplay(dateStr) {
            const date = new Date(dateStr + 'T00:00:00');
            return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        }

        function setLoadingState() {
            const container = document.getElementById('timeSlotsContainer');
            if (!container) return;
            container.className = 'loading';
            container.innerHTML = 'Loading available time slots...';
        }

        function updateSubmitButtonState() {
            const submitButton = document.getElementById('submitButton');
            if (!submitButton) return;
            submitButton.disabled = availableSlots.length === 0;
        }

        function resetTimeSelection() {
            selectedTimeSlot = null;
            const hiddenInput = document.getElementById('selectedTime');
            if (hiddenInput) hiddenInput.value = '';
            document.querySelectorAll('.time-slot.selected').forEach(el => el.classList.remove('selected'));
        }

        async function loadAvailableSlots(requestedDate) {
            setLoadingState();
            resetTimeSelection();
            availableSlots = [];
            updateSubmitButtonState();

            try {
                const query = requestedDate ? '?date=' + encodeURIComponent(requestedDate) : '';
                const response = await fetch('/available-slots' + query);
                const data = await response.json();

                if (response.ok) {
                    const datePicker = document.getElementById('datePicker');
                    const dateHelp = document.getElementById('dateHelp');

                    selectedDate = data.date;
                    availableSlots = data.availableSlots || [];

                    if (datePicker) {
                        datePicker.min = data.minDate;
                        datePicker.max = data.maxDate;
                        datePicker.value = data.date;
                    }

                    if (dateHelp) {
                        dateHelp.textContent = 'Appointments available ' + formatDateForDisplay(data.minDate) + ' to ' + formatDateForDisplay(data.maxDate) + '.';
                    }

                    renderTimeSlots();
                } else {
                    const errorMessage = data.error || 'Unable to load time slots.';
                    showMessage('Error loading time slots: ' + errorMessage, 'error');
                    const container = document.getElementById('timeSlotsContainer');
                    if (container) {
                        container.className = 'loading';
                        container.innerHTML = errorMessage;
                    }
                }
            } catch (error) {
                showMessage('Failed to connect to server', 'error');
                console.error('Error:', error);
                const container = document.getElementById('timeSlotsContainer');
                if (container) {
                    container.className = 'loading';
                    container.innerHTML = 'Unable to load time slots.';
                }
            }
        }

        function renderTimeSlots() {
            const container = document.getElementById('timeSlotsContainer');
            if (!container) return;

            container.innerHTML = '';
            container.className = 'time-slots';

            if (!selectedDate) {
                container.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">Select a date to view available times.</p>';
                updateSubmitButtonState();
                return;
            }

            if (availableSlots.length === 0) {
                container.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">All time slots are booked for ' + formatDateForDisplay(selectedDate) + '. Please choose another date.</p>';
                updateSubmitButtonState();
                return;
            }

            const allSlots = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

            allSlots.forEach(slot => {
                const slotDiv = document.createElement('div');
                const isAvailable = availableSlots.includes(slot);

                slotDiv.className = 'time-slot' + (isAvailable ? '' : ' disabled');
                slotDiv.textContent = slot;

                if (isAvailable) {
                    slotDiv.onclick = function () {
                        selectTimeSlot(slot, slotDiv);
                    };
                }

                container.appendChild(slotDiv);
            });

            updateSubmitButtonState();
        }

        function selectTimeSlot(slot, element) {
            document.querySelectorAll('.time-slot.selected').forEach(el => el.classList.remove('selected'));

            element.classList.add('selected');
            selectedTimeSlot = slot;
            const hiddenInput = document.getElementById('selectedTime');
            if (hiddenInput) hiddenInput.value = slot;
        }

        function showMessage(text, type) {
            const messageArea = document.getElementById('messageArea');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ' + type;
            messageDiv.textContent = text;

            messageArea.innerHTML = '';
            messageArea.appendChild(messageDiv);

            if (type === 'success') {
                setTimeout(function () {
                    messageDiv.remove();
                }, 5000);
            }
        }

        const datePickerElement = document.getElementById('datePicker');
        if (datePickerElement) {
            datePickerElement.addEventListener('change', function (e) {
                const newDate = e.target.value;
                loadAvailableSlots(newDate);
            });
        }

        document.getElementById('bookingForm').addEventListener('submit', async function (e) {
            e.preventDefault();

            const datePicker = document.getElementById('datePicker');
            selectedDate = datePicker ? datePicker.value : null;

            if (!selectedDate) {
                showMessage('Please select a date', 'error');
                return;
            }

            if (!selectedTimeSlot) {
                showMessage('Please select a time slot', 'error');
                return;
            }

            const submitButton = document.getElementById('submitButton');
            submitButton.disabled = true;
            submitButton.textContent = 'Booking...';

            const reservedTime = selectedTimeSlot;
            const reservedDate = selectedDate;

            const formData = {
                date: reservedDate,
                timeSlot: reservedTime,
                name: document.getElementById('name').value,
                email: document.getElementById('email').value,
                gender: document.getElementById('gender').value,
                age: parseInt(document.getElementById('age').value, 10)
            };

            try {
                const response = await fetch('/book', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(formData)
                });

                const data = await response.json();

                if (response.ok) {
                    showMessage('✅ Success! Your appointment is booked for ' + formatDateForDisplay(reservedDate) + ' at ' + reservedTime, 'success');

                    document.getElementById('name').value = '';
                    document.getElementById('email').value = '';
                    document.getElementById('gender').value = '';
                    document.getElementById('age').value = '';
                    resetTimeSelection();

                    setTimeout(function () {
                        loadAvailableSlots(reservedDate);
                    }, 500);
                } else {
                    showMessage('Error: ' + (data.error || 'Unable to complete booking'), 'error');
                }
            } catch (error) {
                showMessage('Failed to book appointment. Please try again.', 'error');
                console.error('Error:', error);
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = 'Book Appointment';
            }
        });

        window.addEventListener('load', function () {
            loadAvailableSlots();
        });
    </script>
</body>
</html>
  `)
})

app.get('/available-slots', async (req, res) => {
  try {
    const bounds = getDateBounds()
    const requestedDate = typeof req.query.date === 'string' ? req.query.date : ''
    const date = isValidBookingDate(requestedDate) ? requestedDate : bounds.minDate

    const bookings = await loadBookings()
    const bookedSlots = bookings
      .filter(booking => {
        const bookingDate = booking.date || (booking.timestamp ? toDateOnlyString(new Date(booking.timestamp)) : null)
        return bookingDate === date
      })
      .map(booking => booking.timeSlot)

    const availableSlots = ALL_TIME_SLOTS.filter(slot => !bookedSlots.includes(slot))

    res.json({
      date,
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      availableSlots,
      bookedSlots
    })
  } catch (error) {
    console.error('Error getting available slots:', error)
    res.status(500).json({ error: 'Failed to load available time slots' })
  }
})

app.post('/book', async (req, res) => {
  console.log('=== BOOKING REQUEST START ===')
  console.log('Incoming booking request received')

  try {
    const { date, timeSlot, name, email, gender, age } = req.body

    if (!date || !timeSlot || !name || !email || !gender || (typeof age === 'undefined' || age === null)) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    if (!isValidBookingDate(date)) {
      return res.status(400).json({ error: 'Invalid booking date' })
    }

    if (!ALL_TIME_SLOTS.includes(timeSlot)) {
      return res.status(400).json({ error: 'Invalid time slot' })
    }

    const parsedAge = parseInt(age, 10)
    if (Number.isNaN(parsedAge) || parsedAge < 1 || parsedAge > 120) {
      return res.status(400).json({ error: 'Invalid age provided' })
    }

    const bookings = await loadBookings()

    const normalizedIncomingEmail = normalizeEmail(email)
    let replacedBooking = null
    const bookingsWithoutEmail = bookings.filter(existing => {
      const matches = normalizeEmail(existing.email) === normalizedIncomingEmail
      if (matches && !replacedBooking) {
        replacedBooking = existing
      }
      return !matches
    })

    const slotBooked = bookingsWithoutEmail.some(booking => {
      const bookingDate = booking.date || (booking.timestamp ? toDateOnlyString(new Date(booking.timestamp)) : null)
      return bookingDate === date && booking.timeSlot === timeSlot
    })

    if (slotBooked) {
      return res.status(400).json({ error: 'This time slot has already been booked for the selected date' })
    }

    const newBooking = {
      id: Date.now().toString(),
      date,
      timeSlot,
      name,
      email,
      gender,
      age: parsedAge,
      timestamp: new Date().toISOString()
    }

    // Save the new booking
    if (kv) {
      // For Vercel KV, remove previous entry for this email (if any) and save directly
      if (replacedBooking) {
        try {
          await kv.del(`booking:${replacedBooking.id}`)
        } catch (error) {
          console.error('Error removing previous booking from Vercel KV:', error)
        }
      }
      await kv.set(`booking:${newBooking.id}`, newBooking)
    } else {
      // For file system, replace existing entry (if any) then save
      const finalBookings = [...bookingsWithoutEmail, newBooking]
      await saveBookings(finalBookings)
    }

    res.json({
      success: true,
      message: replacedBooking ? 'Booking updated' : 'Booking confirmed',
      booking: newBooking,
      replacedExistingBooking: Boolean(replacedBooking)
    })

    console.log('=== BOOKING REQUEST END (SUCCESS) ===')
  } catch (error) {
    console.error('=== BOOKING ERROR ===')
    console.error('Error creating booking:', error)
    res.status(500).json({ error: 'Failed to create booking' })
  }
})

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Booking Calendar app listening on port ${port}`)
    console.log(`Open http://localhost:${port} in your browser`)
  })
}

module.exports = app
