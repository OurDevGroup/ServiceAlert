module.exports = (config, cookies, onSiteSelected) => {
    var request = require('request');
    request = request.defaults({ jar: cookies });

    var getSiteList = (config, cookies, onSites) => {
        if (config.console && config.verbose) console.log("Fetching site list.");

        request.get({
            followAllRedirects: true,
            gzip: true,
            url: config.baseUri + '/on/demandware.store/Sites-Site/default/ViewApplication-SelectSite'
        }, (error, res, body) => {
            if (res.statusCode == 200) {
                if (config.console && config.verbose) console.log("Got site list.");

                const cheerio = require('cheerio');
                const $ = cheerio.load(body);

                var siteSelector = $('select[name="SelectedSiteID"]');

                if (siteSelector) {
                    var options = siteSelector.find('option');
                    config.sites = {};
                    options.map((i, e) => {
                        if (e.name == 'option' && e.children.length > 0 && e.attribs && e.attribs.value) {
                            config.sites[e.children[0].data] = e.attribs.value;
                        }
                    });

                    if (onSites) {
                        onSites(config.sites);
                    }
                }
            }
        });
    }; //getSiteList

    getSiteList(config, cookies, (sites) => {
        request.get({
            followAllRedirects: true,
            gzip: true,
            url: config.baseUri + '/on/demandware.store/Sites-Site/default/ViewApplication-SelectSite?SelectedSiteID=' + config.sites[config.site]
        }, (error, res, body) => {
            if (res.statusCode == 200) {
                if (config.console && config.verbose) console.log("Site set.");
                const cheerio = require('cheerio');
                const $ = cheerio.load(body);

                var title = $("title").text();

                if (title.indexOf(config.site) > 0) {
                    if (onSiteSelected)
                        onSiteSelected();
                }
            }
        });
    });
};