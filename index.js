process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
var config = require('./config.json');

var login_failed_text = 'login_failed';
var instance = config.instance;
var login_path = '/on/demandware.store/Sites-Site/default/ViewApplication-ProcessLogin';
var service_path = '/on/demandware.store/Sites-Site/default/ServiceAnalytics-FetchStatOverview';
var base_path = '/on/demandware.store/Sites-Site/default/';

const maxData = config.maxData;
const queryInterval = config.queryInterval;

const twilio_accountSid = config.twilio_accountSid; // Your Account SID from www.twilio.com/console
const twilio_authToken = config.twilio_authToken; // Your Auth Token from www.twilio.com/console
const twilio_number = config.twilio_number;
const twilio_messageRate = config.twilio_messageRate; //frequency between service messages

const notify_number = config.notify_number;

const default_priority = 2; //2 deviations from normal

var needsAuth = true;
var authCookies = null;

function auth(user, pass, onAuth) {
    if (!user || user.length == 0 || !pass || pass.length == 0) {
        if (config.console) console.log("Unable to authenticate, missing username or password.");
        return;
    }
    var https = require('https');
    if (config.console) console.log("Authenticating " + user + "...");
    https.get('https://' + instance + ":" + (config.port || 443) + base_path, (res) => {
        var cookies = parseCookies(res);

        var options = {
            hostname: instance,
            port: config.port || 443,
            path: login_path,
            method: 'POST',
            headers: {
                'cookie': cookies.join(';'),
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'DemandwareServiceAlert',
                'Accept': '*/*',
                'content-length': '101'
            }
        }

        const req = https.request(options, (res) => {

            res.on('data', (d) => {
                process.stdout.write(d);
            });

            if (res.statusCode == 302) {
                if (config.console) console.log("User authenticated.");
                var cookies = parseCookies(res);
                if (onAuth) {
                    onAuth(cookies)
                }
            } else {
                if (config.console) console.log("Unable to authenticate, check username & password!");
                process.exit(1);
                return;
            }
        });

        req.on('error', (e) => {
            process.exit(1);
        });

        var querystring = require('querystring');

        var data = querystring.stringify({
            LoginForm_Password: pass,
            LoginForm_Login: user,
            LocaleID: '',
            LoginForm_RegistrationDomain: 'Sites'
        });

        req.write(data);

        req.end();

    }); //fetch cookie
} //auth

function parseCookies(res) {
    if (!config.cookies) config.cookies = {};
    if (!(res && res.headers && res.headers['set-cookie'])) return;
    var setCookies = {};
    res.headers['set-cookie'].map((cookie) => {
        var c = cookie.split(';');
        c.map((cookie) => {
            var cookieName = cookie.split('=')[0];
            if (cookieName == 'sid')
                config.cookies[cookieName] = cookie;
            if (cookieName == 'dwsid')
                config.cookies[cookieName] = cookie;
            if (cookieName.substring(0, "dwsecuretoken".length) == "dwsecuretoken")
                config.cookies[cookieName] = cookie;
        });
    });
    for (c in setCookies) {
        config.cookies[c] = setCookies[c];
    }

    if (!config.cookies.toArray) {
        config.cookies.toArray = () => {
            var cookies = [];
            for (k in config.cookies) {
                if (typeof config.cookies[k] !== 'object' && typeof config.cookies[k] !== 'function')
                    cookies.push(config.cookies[k]);
            }
            return cookies; //return cookie array
        };
    }

    return config.cookies.toArray();
}

function fetch(authCookies, gotStats) {
    var options = {
        hostname: instance,
        port: config.port || 443,
        path: service_path,
        method: 'GET',
        headers: {
            'cookie': authCookies.join(';'),
            'User-Agent': 'DemandwareServiceAlert',
            'Accept': '*/*',
        }
    }

    if (config.console && config.verbose) console.log("Fetching stats.");

    var https = require('https');
    const req = https.request(options, (res) => {

        var cookies = parseCookies(res);

        var bodyChunks = [];
        if (res.statusCode == 200) {
            res.on('data', function(chunk) {
                bodyChunks.push(chunk);
            });
            res.on('end', function() {
                jsonResp = Buffer.concat(bodyChunks).toString();

                jsonResp = jsonResp.substring(2, jsonResp.length - 1);
                jsonResp = jsonResp.replace('responseStatus', '"responseStatus"');
                jsonResp = jsonResp.replace('responseText', '"responseText"');

                var status = JSON.parse(jsonResp);

                if (status && status.responseText.status.length > 0) {
                    status.responseText.status.map((status) => {
                        if ((status.headStat.error_rate && status.headStat.error_rate > 0) ||
                            (status.headStat.unavailable_rate && status.headStat.unavailable_rate > 0)) {
                            if (gotStats) {
                                gotStats(status);
                            }
                        }
                    });
                }
            });
        }
    });
    req.end();
}

function fetchServiceStatus(gotStats) {
    if (!config.authenticated || !config.cookies) {
        auth(config.user, config.password, (cookies) => {
            config.authenticated = true;
            fetch(config.cookies.toArray(), gotStats);
        });
    } else {
        fetch(config.cookies.toArray(), gotStats);
    }
} //fetch status

var runningStatus = {};
var startTime = Date.now();

function newStatCollection(defaults) {
    var x = (defaults) => {
        var statCol = new function() {
            this.name = '';

            this.ignore = false;

            this.priority = default_priority;

            this.last_alert = 0;

            this.stats = {};
        }

        if (defaults) {
            for (k in defaults) {
                if (k != "stats") {
                    statCol[k] = defaults[k];
                }
            }
        }

        return statCol;
    };

    return x(defaults);
}

function newStat(defaults) {
    var x = (defaults) => {
        var stat = new function() {
            this.ignore = false;

            this.name = '';

            this.default = null;

            this.direction = 1; //-1 for negative

            this.getPreviousRate = () => {
                return this.history.length > 1 ? this.history[this.history.length - 2] : this.default;
            };

            this.getCurrentRate = () => {
                return this.history.length > 0 ? this.history[this.history.length - 1] : this.default;
            };

            this._total = null;

            this.getTotal = () => {
                var total = 0;
                this.history.map((v) => { total += v; });
                this._total = total;
                return total;
            };

            this._mean = null;

            this.getMean = () => {
                var total = this.getTotal();
                this._mean = total / this.history.length;
                return this._mean;
            };

            this._standardDeviation = null;

            this.getStandardDeviation = () => {
                var mean = this.getMean();
                var total = 0;
                this.history.map((v) => {
                    total += Math.pow(v - mean, 2);
                });
                this._standardDeviation = Math.sqrt(total / this.history.length);
                return this._standardDeviation;
            };

            this.push = (val) => {
                this.history.push(val);
                if (this.history.length > maxData) {
                    this.history.splice(0, this.history.length - maxData);
                }
                return val;
            };

            this.history = [];
        };

        if (defaults) {
            for (key in defaults) {
                stat[key] = defaults[key];
            }
        }

        return stat;
    };
    return x(defaults);
}

function computeStats() {
    fetchServiceStatus((status) => {
        if (!runningStatus[status.id]) {
            runningStatus[status.id] = newStatCollection({ name: status.id });
            if (config.console && config.verbose) console.log("Logging " + status.id + " as new service.");
        }

        var s = runningStatus[status.id];

        if (s.ignore) return;

        var v = {};
        for (k in s.stats) {
            if (s.stats[k].ignore) continue;
            if (s.stats[k].default) {
                v[k] = s.stats[k].default;
            }
        }

        for (k in status.headStat) {
            if (s.stats[k] && s.stats[k].ignore) continue;
            v[k] = status.headStat[k];
        }

        for (k in v) {

            if (!s.stats[k] || typeof s.stats[k] === 'undefined') {
                if (config.services &&
                    config.services[status.id] &&
                    config.services[status.id].stats &&
                    config.services[status.id].stats[k]) {
                    var d = config.services[status.id].stats[k];
                    if (!d.name) d['name'] = k;
                    s.stats[k] = newStat(d);
                } else {
                    s.stats[k] = newStat({ name: k });
                }
                if (config.console && config.verbose) console.log("Logging " + k + " as new metric for " + status.id + ".");
            }

            s.stats[k].push(v[k]);
            if (config.console && config.verbose) console.log("Pushing " + v[k] + " to " + status.id + "." + k);

            var fs = require('fs');
            fs.writeFileSync('./data.json', JSON.stringify(runningStatus, null, 2), 'utf-8');

            if (k == "error_rate" || k == "unavailable_rate") {
                s.stats[k].default = 0;
            } else {
                s.stats[k].default = null;
            }

            if (k == "success_rate")
                s.stats[k].direction = -1; //only care if the value is decreasing
        }

        for (k in s.stats) {
            var stat = s.stats[k];

            //don't bother checking unless you have a certain number of values            
            if (stat.history.length >= (config.minData || 20)) {
                if ((stat.getPreviousRate() - stat.getCurrentRate()) * stat.direction < 0) {
                    if (stat.getCurrentRate()) {
                        if (stat.getCurrentRate() - stat.getMean() > stat.getStandardDeviation() * s.priority) {
                            var msg = s.name + " has an abnormal " + (stat.direction > 0 ? "increase" : "decrease") + " in " + stat.name + " with a value of " + Number(stat.getCurrentRate()).toFixed(6);
                            if (config.console) console.log(msg);
                            if (s.last_alert + twilio_messageRate < Date.now()) {
                                alert(msg);
                                s.last_alert = Date.now();
                            }
                        }
                    }
                }
            }
        }

    });
}

function alert(message) {
    if (!config.twilio) return;
    if (config.console) console.log("Sending message to Twilio.");
    if (twilio_accountSid && twilio_authToken) {
        var twilio = require('twilio');
        var client = new twilio.RestClient(twilio_accountSid, twilio_authToken);

        client.messages.create({
            body: message,
            to: notify_number, // Text this number
            from: twilio_number
        }, function(err, message) {
            if (err) {
                console.error(err.message);
            }
        });
    }

}

function restoreState(prev) {
    if (config.console) console.log("Restoring previous state.");
    if (prev) {
        for (svcName in prev) {
            var svc = prev[svcName];

            var defaults = {};
            for (k in svc) {
                if (typeof svc[k] !== 'object' && typeof svc[k] !== 'function') {
                    defaults[k] = svc[k];
                }
            }
            runningStatus[svcName] = newStatCollection(defaults);
            if (svc['stats']) {
                for (metricName in svc.stats) {
                    var stat = svc.stats[metricName]; //error_rate                    
                    defaults = {};
                    for (k in stat) {
                        if (typeof stat[k] !== 'object' && typeof stat[k] !== 'function') {
                            defaults[k] = stat[k];
                        }
                    }
                    runningStatus[svcName].stats[metricName] = newStat(defaults);
                    if (stat.history) {
                        for (h in stat.history) {
                            runningStatus[svcName].stats[metricName].history.push(stat.history[h]);
                        }
                    }
                }
            }
        }
    }
}

function run() {
    if (config.services && !config.restore) {
        for (s in config.services) {
            runningStatus[s] = newStatCollection(config.services[s]);
        }
    }

    setInterval(computeStats, queryInterval);
};

process.argv.forEach(function(val, index, array) {
    switch (val) {
        case "--help":
            console.log("--help  \tHelp for the command line.\n--restore\tRestore previous data state instead of starting a new one.\n--console\tOutput information to the console window.\n--twilio\tSend messages via Twilio\n--verbose\tBe more verbose on messages.");
            process.exit(1);
            break;
        case "--restore":
            var fs = require('fs');
            if (fs.existsSync('./data.json')) {
                config.restore = true;
                runningStatus = require('./data.json');
                restoreState(runningStatus);
            }
            break;
        case "--console":
            config.console = true;
            break;
        case "--twilio":
            config.twilio = true;
            break;
        case "--verbose":
            config.verbose = true;
            break;
    }
});

if ((!config.instance || config.instance.length == 0) && config.console) console.log("Unable to log data, missing instance name.");

run();