module.exports = (config, cookies, user, pass, onAuthenticated) => {
    var request = require('request');
    request = request.defaults({ jar: cookies });

    if (!user || user.length == 0 || !pass || pass.length == 0) {
        if (config.console) console.log("Unable to authenticate, missing username or password.");
        return;
    }

    if (config.console) console.log("Authenticating " + user + "...");

    request.post({
            followAllRedirects: true,
            url: config.baseUri + config.login_path,
            gzip: true,
            form: {
                LoginForm_Password: pass,
                LoginForm_Login: user,
                LocaleID: '',
                LoginForm_RegistrationDomain: 'Sites'
            }
        },
        (error, res, body) => {
            if (res.statusCode == 200 || res.statusCode == 200) { //??
                if (config.console) console.log("User authenticated.");

                if (onAuthenticated) {
                    onAuthenticated()
                }
            } else {
                if (config.console) console.log("Unable to authenticate, check username & password!");
                process.exit(1);
                return;
            }
        });

};