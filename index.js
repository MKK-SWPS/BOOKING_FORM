const express = require('express')
const fs = require('fs').promises
const path = require('path')
const { createEvents } = require('ics')

const app = express()
const port = 3000

// Google Apps Script Web App URL for storing bookings in Google Sheets
// This handles: storage, email notifications, and calendar events
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || ''

if (GOOGLE_SCRIPT_URL) {
  console.log('Google Sheets integration enabled')
} else {
  console.log('Google Sheets integration disabled (set GOOGLE_SCRIPT_URL to enable)')
  console.log('Using local file system for storage')
}

app.use(express.json())
app.use(express.static('public'))

const BOOKINGS_DIR = path.join(__dirname, 'bookings')
const BOOKINGS_FILE = path.join(BOOKINGS_DIR, 'all-bookings.json')

// Load booking configuration from JSON file
// Format: { "days": [{ "date": "2026-03-02", "startHour": 9, "endHour": 17 }, ...] }
function loadBookingConfig() {
  try {
    const configPath = path.join(__dirname, 'config', 'booking-dates.json')
    delete require.cache[require.resolve(configPath)]
    const config = require(configPath)
    
    if (config.days && Array.isArray(config.days) && config.days.length > 0) {
      // New format: list of days with per-day hours
      const sortedDays = [...config.days].sort((a, b) => a.date.localeCompare(b.date))
      return {
        days: sortedDays,
        minDate: sortedDays[0].date,
        maxDate: sortedDays[sortedDays.length - 1].date
      }
    }
    
    // Fallback for old format or missing config
    console.warn('Config missing "days" array, using defaults')
    return getDefaultConfig()
  } catch (error) {
    console.error('Failed to load config/booking-dates.json:', error.message)
    return getDefaultConfig()
  }
}

function getDefaultConfig() {
  return {
    days: [
      { date: '2026-03-02', startHour: 9, endHour: 17 },
      { date: '2026-03-03', startHour: 9, endHour: 17 }
    ],
    minDate: '2026-03-02',
    maxDate: '2026-03-03'
  }
}

// Generate time slots for a specific day
function generateTimeSlotsForDay(dayConfig) {
  if (!dayConfig) return []
  const slots = []
  const startHour = typeof dayConfig.startHour === 'number' ? dayConfig.startHour : 9
  const endHour = typeof dayConfig.endHour === 'number' ? dayConfig.endHour : 17
  for (let hour = startHour; hour <= endHour; hour++) {
    slots.push(`${hour.toString().padStart(2, '0')}:00`)
  }
  return slots
}

// Get day config for a specific date
function getDayConfig(dateStr) {
  const dayConfig = BOOKING_CONFIG.days.find(d => d.date === dateStr)
  return dayConfig || null
}

// Get all time slots for a specific date
function getTimeSlotsForDate(dateStr) {
  const dayConfig = getDayConfig(dateStr)
  return generateTimeSlotsForDay(dayConfig)
}

// Check if a date is valid (exists in config)
function isConfiguredDate(dateStr) {
  return BOOKING_CONFIG.days.some(d => d.date === dateStr)
}

// Get list of all configured dates
function getConfiguredDates() {
  return BOOKING_CONFIG.days.map(d => d.date)
}

const BOOKING_CONFIG = loadBookingConfig()
const MIN_BOOKING_DATE = BOOKING_CONFIG.minDate
const MAX_BOOKING_DATE = BOOKING_CONFIG.maxDate

console.log(`Booking period: ${MIN_BOOKING_DATE} to ${MAX_BOOKING_DATE}`)
console.log(`Configured days: ${BOOKING_CONFIG.days.length}`)
BOOKING_CONFIG.days.forEach(d => {
  console.log(`  ${d.date}: ${d.startHour}:00 - ${d.endHour}:00`)
})

const ALLOWED_EDUCATION_LEVELS = new Set(['higher', 'studies', 'other'])
const EDUCATION_LABELS = {
  higher: 'wyższe',
  studies: 'studiuję',
  other: 'inne'
}

const MAX_TOTAL_BOOKINGS = 30

function toDateOnlyString(date) {
  const normalized = new Date(date)
  normalized.setHours(0, 0, 0, 0)
  return normalized.toISOString().split('T')[0]
}

function getDateBounds() {
  const dates = getConfiguredDates()
  if (dates.length === 0) {
    return { minDate: null, maxDate: null }
  }
  return { minDate: dates[0], maxDate: dates[dates.length - 1] }
}

function isValidBookingDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return false
  }

  const parsed = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return false
  }

  // Check if date is in our configured days
  return isConfiguredDate(dateStr)
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isValidEmail(value) {
  const trimmed = normalizeEmail(value)
  if (!trimmed) {
    return false
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(trimmed)
}

async function ensureBookingsFile() {
  try {
    await fs.access(BOOKINGS_FILE)
  } catch (error) {
    await fs.mkdir(BOOKINGS_DIR, { recursive: true })
    await fs.writeFile(BOOKINGS_FILE, '[]', 'utf8')
  }
}

async function sendToGoogleSheet(booking) {
  if (!GOOGLE_SCRIPT_URL) {
    console.log('Google Script URL not configured, skipping Google Sheet sync')
    return null
  }

  try {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(booking)
    })

    const result = await response.json()

    if (result.success) {
      console.log('Booking synced to Google Sheet:', result.isUpdate ? 'updated' : 'new', result.bookingId)
    } else {
      console.error('Google Sheet sync failed:', result.error)
    }

    return result
  } catch (error) {
    console.error('Error sending to Google Sheet:', error)
    return null
  }
}

async function loadBookings() {
  // Load from local file system (used as fallback/local dev)
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
  // Save to local file system
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
    <title>Rejestracja na Badanie w Lab SWPS</title>
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
          background-color: #4a4a4a;
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
        
        .checkbox-group label {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 0;
        }

        .checkbox-group input[type="checkbox"] {
          width: auto;
          accent-color: #007aff;
        }
        
        .date-picker-container {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .date-picker-container input[type="date"] {
          padding: 12px;
          background-color: #4a4a4a;
          border: 1px solid #3d3d3d;
          border-radius: 8px;
          color: white;
          font-size: 14px;
          cursor: pointer;
        }

        .date-picker-container input[type="date"]::-webkit-calendar-picker-indicator {
          filter: invert(1);
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

        .consent-box {
          background-color: #242424;
          border: 1px solid #3d3d3d;
          border-radius: 10px;
          padding: 16px;
          color: #d9d9d9;
          font-size: 13px;
          line-height: 1.5;
        }

        .consent-text {
          margin-bottom: 12px;
        }

        .consent-label {
          display: flex;
          align-items: center;
          gap: 10px;
          font-weight: 500;
          font-size: 14px;
        }

        .consent-label input[type="checkbox"] {
          width: 18px;
          height: 18px;
          accent-color: #007aff;
        }
        
          #buttonMessageWrapper {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 12px;
            margin-top: 20px;
          }
        
          #buttonMessageArea {
            width: 100%;
          }

        #buttonMessageArea:empty {
          display: none;
        }

          #buttonMessageWrapper .message {
            margin: 0;
            width: 100%;
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
            <h1>📅 Rejestracja na Badanie w Lab SWPS</h1>
            <p>Wybierz dogodny termin i uzupełnij swoje dane</p>
        </div>
        
        <div class="booking-content">
            <div id="messageArea"></div>
            
            <form id="bookingForm">
                <div class="form-section">
                    <h2>Wybierz datę</h2>
                    <div class="date-picker-container">
                        <div class="date-help" id="dateHelp">💡 Kliknij ikonę kalendarza po prawej stronie, aby wybrać datę.</div>
                      <input type="date" id="datePicker" required aria-describedby="dateHelp" min="${MIN_BOOKING_DATE}" max="${MAX_BOOKING_DATE}">
                    </div>
                </div>
                
                <div class="form-section">
                    <h2>Wybierz godzinę</h2>
                    <div id="timeSlotsContainer" class="loading">
                        Loading available time slots...
                    </div>
                    <input type="hidden" id="selectedTime" name="timeSlot">
                </div>
                
                <div class="form-section">
                    <h2>Dane uczestnika</h2>
                    
                    <div class="form-group">
                      <label for="name">Imię i nazwisko <span class="required">*</span></label>
                      <input type="text" id="name" name="name" placeholder="Wpisz imię i nazwisko" required>
                    </div>
                    
                    <div class="form-group">
                      <label for="email">Adres e-mail <span class="required">*</span></label>
                      <input type="text" id="email" name="email" placeholder="twoj.email@przyklad.com" required>
                    </div>
                    
                    <div class="form-group">
                      <label for="gender">Płeć <span class="required">*</span></label>
                        <select id="gender" name="gender" required>
                        <option value="">Wybierz płeć</option>
                        <option value="male">Mężczyzna</option>
                        <option value="female">Kobieta</option>
                        <option value="non-binary">Osoba niebinarna</option>
                        <option value="prefer-not-to-say">Wolę nie podawać</option>
                        </select>
                    </div>
                    
                    <div class="form-group">
                      <label for="age">Wiek <span class="required">*</span></label>
                      <input type="number" id="age" name="age" placeholder="Podaj swój wiek" min="18" max="120" required>
                    </div>

                    <div class="form-group">
                      <label for="education">Wykształcenie <span class="required">*</span></label>
                      <select id="education" name="education" required>
                        <option value="">Wybierz opcję</option>
                        <option value="higher">wyższe</option>
                        <option value="studies">studiuję</option>
                        <option value="other">inne</option>
                      </select>
                    </div>

                    <div class="form-group checkbox-group">
                      <label for="nativePolish">
                        <input type="checkbox" id="nativePolish" name="nativePolish" required>
                        Język polski jest moim pierwszym / ojczystym językiem
                      </label>
                    </div>
                </div>

                  <div class="form-section">
                    <div class="consent-box">
                      <p class="consent-text">
          Administratorem danych osobowych jest Uniwersytet SWPS z siedzibą przy ul. Chodakowskiej 19/31, 03-815 Warszawa. Dane będą przetwarzane w celu rejestracji i organizacji badania naukowego na podstawie udzielonej zgody (art. 6 ust. 1 lit. a RODO). Przysługuje prawo dostępu do danych, ich sprostowania, usunięcia, ograniczenia przetwarzania, przeniesienia, sprzeciwu oraz wycofania zgody w dowolnym momencie bez wpływu na zgodność z prawem przetwarzania przed wycofaniem zgody. Przysługuje także prawo wniesienia skargi do Prezesa UODO. Kontakt do Inspektora Ochrony Danych: iod@swps.edu.pl. Podanie danych jest dobrowolne, ale niezbędne do udziału w badaniu.
                      </p>
                      <label class="consent-label">
                        <input type="checkbox" id="consentCheckbox" required> Zgoda na przetwarzanie danych osobowych — Wyrażam zgodę
                      </label>
                    </div>
                  </div>
                
                <div id="buttonMessageWrapper">
                  <button type="submit" class="submit-button" id="submitButton">
                    Zarezerwuj termin
                  </button>
                  <div id="buttonMessageArea" role="status" aria-live="polite"></div>
                </div>
            </form>
        </div>
    </div>

    <script>
        let availableSlots = [];
        let allSlots = [];
        let configuredDates = [];
        let selectedTimeSlot = null;
        let selectedDate = null;

      function normalizeEmail(value) {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
      }

      function isValidEmail(value) {
        const trimmed = normalizeEmail(value);
        if (!trimmed) {
          return false;
        }

        const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
        return emailRegex.test(trimmed);
      }

      function isValidAdultAge(value) {
        const parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) && parsed >= 18 && parsed <= 120;
      }

        function formatDateForDisplay(dateStr) {
            const date = new Date(dateStr + 'T00:00:00');
            return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        }

        function setLoadingState() {
            const container = document.getElementById('timeSlotsContainer');
            if (!container) return;
            container.className = 'loading';
          container.innerHTML = 'Ładowanie dostępnych terminów...';
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
                    allSlots = data.allSlots || [];
                    configuredDates = data.configuredDates || [];

                    if (datePicker) {
                        datePicker.min = data.minDate;
                        datePicker.max = data.maxDate;
                        datePicker.value = data.date;
                    }

                    if (dateHelp) {
                        const datesInfo = configuredDates.length > 0 
                            ? 'Dostępne dni: ' + configuredDates.map(d => formatDateForDisplay(d)).join(', ')
                            : '💡 Kliknij ikonę kalendarza po prawej stronie, aby wybrać datę.';
                        dateHelp.textContent = datesInfo;
                    }

                    renderTimeSlots();
                } else {
                    const errorMessage = data.error || 'Nie udało się pobrać terminów.';
                    showMessage('Błąd podczas ładowania terminów: ' + errorMessage, 'error');
                    const container = document.getElementById('timeSlotsContainer');
                    if (container) {
                        container.className = 'loading';
                        container.innerHTML = errorMessage;
                    }
                }
            } catch (error) {
                  showMessage('Nie udało się połączyć z serwerem', 'error');
                console.error('Error:', error);
                const container = document.getElementById('timeSlotsContainer');
                if (container) {
                    container.className = 'loading';
                    container.innerHTML = 'Nie udało się pobrać terminów.';
                }
            }
        }

        function renderTimeSlots() {
            const container = document.getElementById('timeSlotsContainer');
            if (!container) return;

            container.innerHTML = '';
            container.className = 'time-slots';

            if (!selectedDate) {
              container.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">Wybierz datę, aby zobaczyć dostępne godziny.</p>';
                updateSubmitButtonState();
                return;
            }

            if (availableSlots.length === 0) {
              container.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">Wszystkie godziny na ' + formatDateForDisplay(selectedDate) + ' są zajęte. Wybierz inny dzień.</p>';
                updateSubmitButtonState();
                return;
            }

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
          const bottomArea = document.getElementById('buttonMessageArea');
          const fallbackArea = document.getElementById('messageArea');
          const targetArea = bottomArea || fallbackArea;

          if (!targetArea) {
            return;
          }

          if (bottomArea && fallbackArea && fallbackArea !== targetArea) {
            fallbackArea.innerHTML = '';
          }

          if (bottomArea) {
            bottomArea.innerHTML = '';
          }

          const messageDiv = document.createElement('div');
          messageDiv.className = 'message ' + type;
          messageDiv.textContent = text;

          targetArea.innerHTML = '';
          targetArea.appendChild(messageDiv);

          if (type !== 'success') {
            setTimeout(function () {
              if (messageDiv.parentElement === targetArea) {
                messageDiv.remove();
              }
            }, 5000);
          }
        }

        const datePickerElement = document.getElementById('datePicker');
        const datePickerContainer = document.querySelector('.date-picker-container');

        if (datePickerElement) {
          let isOpeningPicker = false;

          const openDatePicker = () => {
            if (isOpeningPicker) {
              return;
            }

            isOpeningPicker = true;

            const finish = () => {
              setTimeout(() => {
                isOpeningPicker = false;
              }, 50);
            };

            if (typeof datePickerElement.showPicker === 'function') {
              try {
                datePickerElement.showPicker();
                finish();
                return;
              } catch (pickerError) {
                // Ignore and fall back to focus/click
              }
            }

            datePickerElement.focus({ preventScroll: true });
            const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
            datePickerElement.dispatchEvent(clickEvent);
            finish();
          };

          if (datePickerContainer) {
            datePickerContainer.addEventListener('click', function (event) {
              if (event.target !== datePickerElement) {
                openDatePicker();
              }
            });
          }

          datePickerElement.addEventListener('mousedown', function (event) {
            if (event.button === 0) {
              event.preventDefault();
              openDatePicker();
            }
          });

          datePickerElement.addEventListener('click', function () {
            openDatePicker();
          });

          ['focus', 'touchstart'].forEach(function (eventName) {
            datePickerElement.addEventListener(eventName, function () {
              openDatePicker();
            });
          });

          datePickerElement.addEventListener('keydown', function (event) {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              openDatePicker();
            }
          });
        }

        if (datePickerElement) {
            datePickerElement.addEventListener('change', function (e) {
                const newDate = e.target.value;
                // Validate the selected date is in the configured dates list
                if (configuredDates.length > 0 && !configuredDates.includes(newDate)) {
                    showMessage('Wybrany dzień nie jest dostępny. Dostępne dni: ' + configuredDates.map(d => formatDateForDisplay(d)).join(', '), 'error');
                    // Reset to a valid date
                    if (configuredDates.length > 0) {
                        e.target.value = configuredDates[0];
                        loadAvailableSlots(configuredDates[0]);
                    }
                    return;
                }
                loadAvailableSlots(newDate);
            });
        }

        document.getElementById('bookingForm').addEventListener('submit', async function (e) {
            e.preventDefault();

            const datePicker = document.getElementById('datePicker');
            selectedDate = datePicker ? datePicker.value : null;

            if (!selectedDate) {
                showMessage('Wybierz datę', 'error');
                return;
            }

            if (!selectedTimeSlot) {
                showMessage('Wybierz godzinę', 'error');
                return;
            }

            const submitButton = document.getElementById('submitButton');
            const nameInput = document.getElementById('name');
            const emailInput = document.getElementById('email');
            const genderInput = document.getElementById('gender');
            const ageInput = document.getElementById('age');
            const educationSelect = document.getElementById('education');
            const consentCheckbox = document.getElementById('consentCheckbox');
            const nativePolishCheckbox = document.getElementById('nativePolish');

            const emailValue = emailInput ? emailInput.value : '';
            const ageValue = ageInput ? ageInput.value : '';

            if (!isValidEmail(emailValue)) {
              showMessage('Podaj poprawny adres e-mail', 'error');
              return;
            }

            if (!isValidAdultAge(ageValue)) {
              showMessage('Rezerwacji mogą dokonać wyłącznie osoby pełnoletnie (18+).', 'error');
              return;
            }

            if (!educationSelect || !educationSelect.value) {
              showMessage('Wybierz poziom wykształcenia.', 'error');
              return;
            }

            if (!consentCheckbox || !consentCheckbox.checked) {
              showMessage('Aby kontynuować, zaakceptuj przetwarzanie danych osobowych.', 'error');
              return;
            }

            if (!nativePolishCheckbox || !nativePolishCheckbox.checked) {
              showMessage('Potwierdź, że język polski jest Twoim pierwszym językiem.', 'error');
              return;
            }

            submitButton.disabled = true;
            submitButton.textContent = 'Trwa rezerwacja...';

            const reservedTime = selectedTimeSlot;
            const reservedDate = selectedDate;

            const formData = {
                date: reservedDate,
                timeSlot: reservedTime,
              name: nameInput ? nameInput.value : '',
              email: emailValue.trim(),
              gender: genderInput ? genderInput.value : '',
              age: Number.parseInt(ageValue, 10),
              education: educationSelect ? educationSelect.value : '',
              nativePolishSpeaker: nativePolishCheckbox ? nativePolishCheckbox.checked : false
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
                  let successText = data.replacedExistingBooking
                    ? '🔁 Zaktualizowano! Twoja wizyta została ustawiona na ' + formatDateForDisplay(reservedDate) + ' o ' + reservedTime + '. '
                    : '✅ Sukces! Twoja wizyta została zarezerwowana na ' + formatDateForDisplay(reservedDate) + ' o ' + reservedTime + '. ';

                  if (data.message) {
                    successText += data.message;
                  }

                  showMessage(successText.trim(), 'success');

                    document.getElementById('name').value = '';
                    document.getElementById('email').value = '';
                    document.getElementById('gender').value = '';
                    document.getElementById('age').value = '';
                    if (educationSelect) {
                      educationSelect.value = '';
                    }
                    if (nativePolishCheckbox) {
                      nativePolishCheckbox.checked = false;
                    }
                    if (consentCheckbox) {
                      consentCheckbox.checked = false;
                    }
                    resetTimeSelection();

                    setTimeout(function () {
                        loadAvailableSlots(reservedDate);
                    }, 500);
                } else {
                  showMessage('Błąd: ' + (data.error || 'Nie udało się zrealizować rezerwacji'), 'error');
                }
            } catch (error) {
                showMessage('Nie udało się zarezerwować wizyty. Spróbuj ponownie.', 'error');
                console.error('Error:', error);
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = 'Zarezerwuj termin';
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
    const configuredDates = getConfiguredDates()
    
    if (configuredDates.length === 0) {
      return res.status(500).json({ error: 'Brak skonfigurowanych dat rezerwacji' })
    }
    
    const requestedDate = typeof req.query.date === 'string' ? req.query.date : ''
    const date = isValidBookingDate(requestedDate) ? requestedDate : bounds.minDate

    // Get time slots specific to this date
    const allSlotsForDate = getTimeSlotsForDate(date)

    let bookings = []
    try {
      bookings = await loadBookings()
    } catch (loadError) {
      console.error('Error loading bookings for available slots:', loadError)
      bookings = []
    }

    const bookedSlots = bookings
      .filter(booking => {
        const bookingDate = booking.date || (booking.timestamp ? toDateOnlyString(new Date(booking.timestamp)) : null)
        return bookingDate === date
      })
      .map(booking => booking.timeSlot)

    const availableSlots = allSlotsForDate.filter(slot => !bookedSlots.includes(slot))

    res.json({
      date,
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      configuredDates,
      allSlots: allSlotsForDate,
      availableSlots,
      bookedSlots
    })
  } catch (error) {
    console.error('Error getting available slots:', error)
    res.status(500).json({ error: 'Nie udało się pobrać dostępnych terminów' })
  }
})

app.get('/calendar.ics', async (req, res) => {
  try {
    const bookings = await loadBookings()

    if (!bookings || bookings.length === 0) {
      return res.status(404).send('Brak rezerwacji do eksportu')
    }

    const sortedBookings = [...bookings].sort((a, b) => {
      if (a.date === b.date) {
        return a.timeSlot.localeCompare(b.timeSlot)
      }
      return a.date.localeCompare(b.date)
    })

    const events = []

    for (const booking of sortedBookings) {
      if (!booking.date || !booking.timeSlot) {
        continue
      }

      const [year, month, day] = booking.date.split('-').map(Number)
      const [hour, minute] = booking.timeSlot.split(':').map(Number)

      if ([year, month, day, hour, minute].some(Number.isNaN)) {
        continue
      }

      const titleName = booking.name ? ` - ${booking.name}` : ''
      const summary = `Badanie Lab SWPS${titleName}`
      const descriptionParts = [
        `Data: ${booking.date}`,
        `Godzina: ${booking.timeSlot}`
      ]

      if (booking.name) {
        descriptionParts.push(`Imię i nazwisko: ${booking.name}`)
      }
      if (booking.email) {
        descriptionParts.push(`E-mail: ${booking.email}`)
      }
      if (booking.gender) {
        descriptionParts.push(`Płeć: ${booking.gender}`)
      }
      if (typeof booking.age !== 'undefined') {
        descriptionParts.push(`Wiek: ${booking.age}`)
      }

      if (booking.education) {
        const educationLabel = EDUCATION_LABELS[booking.education] || booking.education
        descriptionParts.push(`Wykształcenie: ${educationLabel}`)
      }

      if (typeof booking.nativePolishSpeaker !== 'undefined') {
        descriptionParts.push(`Polski jako język ojczysty: ${booking.nativePolishSpeaker ? 'Tak' : 'Nie'}`)
      }

      events.push({
        start: [year, month, day, hour, minute],
        duration: { hours: 1 },
        startInputType: 'local',
        startOutputType: 'local',
        title: summary,
        description: descriptionParts.join('\n'),
        location: 'Lab SWPS',
        productId: 'Lab SWPS Booking Calendar',
        status: 'CONFIRMED',
        calName: 'Rezerwacje Lab SWPS',
        uid: `lab-swps-${booking.id || `${booking.date}-${booking.timeSlot}`}`
      })
    }

    if (events.length === 0) {
      return res.status(404).send('Brak poprawnych danych do wygenerowania kalendarza')
    }

    const { error, value } = createEvents(events)

    if (error) {
      console.error('Błąd generowania pliku ICS:', error)
      return res.status(500).send('Nie udało się wygenerować kalendarza')
    }

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="lab-swps-rezerwacje.ics"')
    res.send(value)
  } catch (error) {
    console.error('Błąd tworzenia pliku ICS:', error)
    res.status(500).send('Nie udało się wygenerować kalendarza')
  }
})

app.post('/book', async (req, res) => {
  console.log('=== BOOKING REQUEST START ===')
  console.log('Incoming booking request received')

  try {
    const { date, timeSlot, name, email, gender, age, education, nativePolishSpeaker } = req.body

    if (!date || !timeSlot || !name || !email || !gender || !education || (typeof age === 'undefined' || age === null)) {
      return res.status(400).json({ error: 'Wszystkie pola są wymagane' })
    }

    if (!isValidBookingDate(date)) {
      return res.status(400).json({ error: 'Nieprawidłowa data rezerwacji' })
    }

    // Check if time slot is valid for this specific date
    const validSlotsForDate = getTimeSlotsForDate(date)
    if (!validSlotsForDate.includes(timeSlot)) {
      return res.status(400).json({ error: 'Nieprawidłowy termin dla wybranej daty' })
    }

    const trimmedEmail = typeof email === 'string' ? email.trim() : ''
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ error: 'Podaj prawidłowy adres e-mail' })
    }

    const parsedAge = parseInt(age, 10)
    if (Number.isNaN(parsedAge) || parsedAge < 18 || parsedAge > 120) {
      return res.status(400).json({ error: 'Wiek musi wynosić co najmniej 18 lat' })
    }

    if (!ALLOWED_EDUCATION_LEVELS.has(education)) {
      return res.status(400).json({ error: 'Podano nieprawidłową wartość dla wykształcenia' })
    }

    if (!nativePolishSpeaker) {
      return res.status(400).json({ error: 'Rezerwacja dostępna wyłącznie dla osób, dla których polski jest językiem ojczystym.' })
    }

    const bookings = await loadBookings()

    const normalizedIncomingEmail = normalizeEmail(trimmedEmail)
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
      return res.status(400).json({ error: 'Ten termin jest już zarezerwowany na wybraną datę' })
    }

    const projectedTotalBookings = bookingsWithoutEmail.length + 1
    if (projectedTotalBookings > MAX_TOTAL_BOOKINGS) {
      return res.status(400).json({ error: 'Osiągnięto maksymalną liczbę osób zapisanych na badanie.' })
    }

    const newBooking = {
      id: Date.now().toString(),
      date,
      timeSlot,
      name,
      email: trimmedEmail,
      gender,
      age: parsedAge,
      education,
      nativePolishSpeaker: Boolean(nativePolishSpeaker),
      timestamp: new Date().toISOString()
    }

    // Save locally (as backup)
    const finalBookings = [...bookingsWithoutEmail, newBooking]
    await saveBookings(finalBookings)

    // Sync to Google Sheet (handles storage, notifications + calendar)
    if (GOOGLE_SCRIPT_URL) {
      void sendToGoogleSheet(newBooking)
    }

    res.json({
      success: true,
      message: replacedBooking
        ? 'Poprzednia rezerwacja została zastąpiona nowymi danymi.'
        : 'Rezerwacja została zapisana.',
      booking: newBooking,
      replacedExistingBooking: Boolean(replacedBooking)
    })

    console.log('=== BOOKING REQUEST END (SUCCESS) ===')
  } catch (error) {
    console.error('=== BOOKING ERROR ===')
    console.error('Error creating booking:', error)
    res.status(500).json({ error: 'Nie udało się zapisać rezerwacji' })
  }
})

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Booking Calendar app listening on port ${port}`)
    console.log(`Open http://localhost:${port} in your browser`)
  })
}

module.exports = app
